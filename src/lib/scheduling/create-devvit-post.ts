import 'server-only'
import { requireUser } from '@/lib/auth/require-user'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getDevvitPublisher } from '@/lib/publishing/factory'
import { buildPayload, PayloadError } from './payload-builder'
import { FIELD_DEFAULTS } from '@/lib/reddit/requirements'
import { toUtc } from './timezone'
import type { NewDevvitPostInput } from '@/app/(dashboard)/dashboard/new/schema'

export type CreateDevvitResult = {
  postId: string
}

export class DevvitInstallationError extends Error {
  constructor() {
    super('Instalação Devvit não encontrada ou desativada.')
    this.name = 'DevvitInstallationError'
  }
}

/**
 * Cria uma publicação agendada pelo caminho Devvit.
 *
 * Totalmente independente das credenciais REDDIT_*: nada aqui chama OAuth,
 * Data API, requirements, budget ou proxy. A identidade vem de requireUser();
 * a comunidade vem EXCLUSIVAMENTE da instalação carregada pelo id — nunca de
 * um nome enviado pelo navegador. A RLS limita a consulta às instalações do
 * próprio usuário, e a RPC revalida owner e status antes de gravar.
 *
 * Validações locais apenas (formato e tamanho): as regras reais da comunidade
 * — flair obrigatório, domínios, título mínimo — não são simuladas; quem as
 * aplica é o Reddit quando o app Devvit publicar, e o erro real fica gravado.
 */
export async function createDevvitPost(
  input: NewDevvitPostInput,
): Promise<CreateDevvitResult> {
  const user = await requireUser()

  const supabase = await createServerSupabase()
  const { data: instalacao } = await supabase
    .from('devvit_installations')
    .select('id, subreddit_name, app_slug, install_location_id, status')
    .eq('id', input.devvitInstallationId)
    .eq('status', 'active')
    .maybeSingle()

  if (!instalacao) {
    throw new DevvitInstallationError()
  }

  // --- horário ---
  const quando =
    input.publishMode === 'now'
      ? new Date()
      : toUtc(
          { date: input.date, time: input.time, timeZone: input.timeZone },
          { occurrence: input.occurrence },
        )

  // --- payload ---
  // FIELD_DEFAULTS não inventa restrição de comunidade: só os limites duros
  // (título ≤ 300, URL http/https, link+texto exige confirmação).
  const payload = buildPayload(
    {
      title: input.title,
      url: input.url || undefined,
      body: input.body || undefined,
      // Flair fica fora do caminho Devvit nesta fase: listar flairs exigiria
      // a Data API.
      flairId: undefined,
      nsfw: input.nsfw,
      spoiler: input.spoiler,
      allowCommentFallback: input.allowCommentFallback || input.addComment,
    },
    FIELD_DEFAULTS,
    {
      name: instalacao.subreddit_name,
      submissionType: 'any',
      linkFlairEnabled: false,
    },
  )

  // --- comentário ---
  // O fluxo provado no Devvit publica o primeiro comentário logo após o post;
  // por isso o modo é sempre 'immediate' (o schema nem oferece outro).
  const corpoComentario = input.addComment
    ? input.commentBody
    : payload.commentBody

  const comentario = corpoComentario
    ? { body: corpoComentario, mode: 'immediate' }
    : null

  // --- gravação atômica ---
  const admin = createAdminSupabase()
  const { data, error } = await admin.rpc('create_scheduled_post', {
    p_owner_id: user.id,
    p_post: {
      title: payload.title,
      url: payload.url,
      body: payload.body,
      post_kind: payload.postKind,
      nsfw: payload.nsfw,
      spoiler: payload.spoiler,
      scheduled_at: quando.toISOString(),
      timezone: input.timeZone,
      status: 'scheduled',
      publisher: 'devvit',
      devvit_installation_id: instalacao.id,
    },
    p_comment: comentario,
  })

  if (error || !data) {
    throw error ?? new Error('Falha ao gravar a publicação.')
  }

  const postId = data as string

  // --- sincronização com o Devvit ---
  // 'unavailable' mantém pending; recusa/erro de rede ficam registrados.
  // Nunca há fallback para o worker: os claims filtram publisher no banco.
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
    await admin
      .from('scheduled_posts')
      .update({
        devvit_sync_status: 'failed',
        devvit_sync_error: resultado.message,
      })
      .eq('id', postId)
  }

  return { postId }
}

export { PayloadError }
