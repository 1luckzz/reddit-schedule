import 'server-only'
import type { Dispatcher } from 'undici'
import { requireUser } from '@/lib/auth/require-user'
import { assertAccountAccess } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { getPostRequirements } from '@/lib/reddit/requirements'
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

  // Este caminho é SEMPRE publisher='worker'. O destino Devvit tem fluxo
  // próprio (createDevvitPost), com formulário tipado — o navegador nunca
  // escolhe publisher, e este arquivo permanece o legacy intacto.

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
    },
    p_comment: comentario,
  })

  if (error || !data) {
    throw error ?? new Error('Falha ao gravar a publicação.')
  }

  return { postId: data as string }
}

export { PayloadError }
