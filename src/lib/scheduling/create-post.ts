import 'server-only'
import type { Dispatcher } from 'undici'
import { requireUser } from '@/lib/auth/require-user'
import { assertAccountAccess } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { getPostRequirements } from '@/lib/reddit/requirements'
import { getDevvitPublisher } from '@/lib/publishing/factory'
import { buildPayload, PayloadError } from './payload-builder'
import { toUtc } from './timezone'
import type { NewPostInput } from '@/app/(dashboard)/dashboard/new/schema'

export type CreateResult = {
  postId: string
}

export class SubredditMismatchError extends Error {
  constructor() {
    super('A comunidade escolhida não pertence a esta conta.')
    this.name = 'SubredditMismatchError'
  }
}

/**
 * Cria uma publicação agendada.
 *
 * A ordem importa: identidade primeiro, posse antes de qualquer leitura de
 * segredo, requisitos antes de validar, e gravação atômica no fim. Falha ao
 * ler requisitos interrompe — nunca vira validação permissiva.
 *
 * O dono da publicação vem SEMPRE de requireUser(), que valida a assinatura
 * do JWT. Nenhum campo do formulário influencia essa decisão.
 */
export async function createPost(
  input: NewPostInput,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<CreateResult> {
  // Identidade confiável: base de tudo que vem depois.
  const user = await requireUser()
  const account = await assertAccountAccess(input.accountId)

  const supabase = await createServerSupabase()
  const { data: subreddit } = await supabase
    .from('subreddits')
    .select('id, name, submission_type, link_flair_enabled, reddit_account_id, status')
    .eq('id', input.subredditId)
    .maybeSingle()

  // A RLS já garante que a comunidade é do usuário; falta garantir que é
  // desta conta. A RPC barraria na gravação, mas a mensagem aqui é melhor.
  if (!subreddit || subreddit.reddit_account_id !== account.id) {
    throw new SubredditMismatchError()
  }

  // --- mecanismo de publicação ---
  // Decisão automática do backend, nunca do formulário: se a comunidade tem
  // uma instalação Devvit ativa deste usuário, a publicação sai pelo Devvit
  // (como conta do app). A RLS restringe a consulta às instalações do próprio
  // usuário, e a RPC revalida a correspondência antes de gravar.
  const { data: instalacao } = await supabase
    .from('devvit_installations')
    .select('id, app_slug, install_location_id, subreddit_name')
    .eq('subreddit_name', subreddit.name.toLowerCase())
    .eq('status', 'active')
    .maybeSingle()

  // --- horário ---
  // toUtc lança em horário inexistente e em ambíguo sem escolha explícita.
  const quando =
    input.publishMode === 'now'
      ? new Date()
      : toUtc(
          {
            date: input.date,
            time: input.time,
            timeZone: input.timeZone,
          },
          { occurrence: input.occurrence },
        )

  // --- requisitos reais da comunidade ---
  const client = await getRedditClient(account, opts)
  const requirements = await getPostRequirements(client, subreddit.name)

  // --- payload ---
  const payload = buildPayload(
    {
      title: input.title,
      url: input.url || undefined,
      body: input.body || undefined,
      flairId: input.flairId || undefined,
      nsfw: input.nsfw,
      spoiler: input.spoiler,
      allowCommentFallback: input.allowCommentFallback || input.addComment,
    },
    requirements,
    {
      name: subreddit.name,
      submissionType:
        (subreddit.submission_type as 'any' | 'link' | 'self') ?? 'any',
      linkFlairEnabled: Boolean(subreddit.link_flair_enabled),
    },
  )

  // --- comentário ---
  // Duas origens possíveis: o texto redirecionado pelo payload builder, ou um
  // comentário escrito de propósito pelo usuário. O explícito vence.
  const corpoComentario = input.addComment
    ? input.commentBody
    : payload.commentBody

  let comentario: Record<string, unknown> | null = null
  if (corpoComentario) {
    const modo = input.addComment ? input.commentMode : 'immediate'
    comentario = {
      body: corpoComentario,
      mode: modo,
      delay_minutes: modo === 'delay' ? input.commentDelayMinutes : null,
      scheduled_at:
        modo === 'absolute'
          ? toUtc(
              {
                date: input.commentDate,
                time: input.commentTime,
                timeZone: input.timeZone,
              },
              { occurrence: input.occurrence },
            ).toISOString()
          : null,
    }
  }

  // --- gravação atômica ---
  // A RPC é exclusiva do service_role: o cliente não pode chamá-la e assim
  // pular a validação de post_requirements acima. O owner vai como parâmetro
  // verificado, nunca vindo do formulário.
  const admin = createAdminSupabase()
  const { data, error } = await admin.rpc('create_scheduled_post', {
    p_owner_id: user.id,
    p_post: {
      reddit_account_id: account.id,
      subreddit_id: subreddit.id,
      title: payload.title,
      url: payload.url,
      body: payload.body,
      post_kind: payload.postKind,
      flair_id: payload.flairId,
      nsfw: payload.nsfw,
      spoiler: payload.spoiler,
      scheduled_at: quando.toISOString(),
      timezone: input.timeZone,
      status: 'scheduled',
      ...(instalacao
        ? { publisher: 'devvit', devvit_installation_id: instalacao.id }
        : {}),
    },
    p_comment: comentario,
  })

  if (error || !data) {
    throw error ?? new Error('Falha ao gravar a publicação.')
  }

  const postId = data as string

  // --- sincronização com o Devvit ---
  // O registro já está salvo com devvit_sync_status = 'pending'. A falha da
  // ponte NUNCA vira fallback para o worker (os claims filtram publisher) e
  // NUNCA desfaz a gravação: o post fica visível aguardando sincronização.
  if (instalacao) {
    const resultado = await getDevvitPublisher().schedule({
      postId,
      subredditName: instalacao.subreddit_name,
      appSlug: instalacao.app_slug,
      installLocationId: instalacao.install_location_id,
      title: payload.title,
      kind: payload.postKind,
      url: payload.url ?? undefined,
      body: payload.body ?? undefined,
      commentBody: corpoComentario ?? undefined,
      flairId: payload.flairId ?? undefined,
      nsfw: payload.nsfw,
      spoiler: payload.spoiler,
      runAtUtc: quando.toISOString(),
    })

    if (resultado.ok) {
      await admin
        .from('scheduled_posts')
        .update({
          devvit_job_id: resultado.devvitJobId,
          devvit_sync_status: 'accepted',
        })
        .eq('id', postId)
    } else if (resultado.code !== 'unavailable') {
      // 'unavailable' fica em 'pending': é ausência de ponte, não uma falha
      // deste registro. Recusa ou erro de rede ficam registrados para a UI.
      await admin
        .from('scheduled_posts')
        .update({
          devvit_sync_status: 'failed',
          devvit_sync_error: resultado.message,
        })
        .eq('id', postId)
    }
  }

  return { postId }
}

export { PayloadError }
