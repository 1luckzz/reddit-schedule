import type { RedditClient } from './client'
import { RedditError } from './errors'

export type SubmitPostInput = {
  subredditName: string
  postKind: 'link' | 'self'
  title: string
  url: string | null
  body: string | null
  flairId: string | null
  nsfw: boolean
  spoiler: boolean
}

export type SubmitResult = {
  redditPostId: string
  redditFullname: string
  permalink: string | null
}

type SubmitResponse = {
  json?: { data?: { id?: string; name?: string; url?: string } }
}

/**
 * Publica na comunidade.
 *
 * `hasSideEffect: true` é obrigatório: é o que faz o cliente classificar 5xx
 * e queda de conexão como resultado desconhecido, em vez de retentável.
 * Retentar às cegas aqui publicaria duas vezes.
 */
export async function submitPost(
  client: RedditClient,
  input: SubmitPostInput,
): Promise<SubmitResult> {
  const form: Record<string, string> = {
    sr: input.subredditName,
    kind: input.postKind,
    title: input.title,
  }

  if (input.postKind === 'link') {
    form.url = input.url ?? ''
  } else {
    form.text = input.body ?? ''
  }

  if (input.flairId) form.flair_id = input.flairId
  if (input.nsfw) form.nsfw = 'true'
  if (input.spoiler) form.spoiler = 'true'

  const { data } = await client.request<SubmitResponse>({
    path: '/api/submit',
    method: 'POST',
    form,
    hasSideEffect: true,
  })

  const criado = data?.json?.data
  const fullname = criado?.name
  const id = criado?.id

  if (!fullname || !id) {
    // O Reddit respondeu 200 sem erros, mas sem identificar a publicação. Ela
    // pode ter sido criada: sem o fullname não há como comentar nem registrar
    // o permalink, e retentar arriscaria publicar duas vezes.
    throw new RedditError({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
      userMessage:
        'O Reddit aceitou a publicação mas não informou qual foi. Esta ação precisa de revisão manual.',
    })
  }

  return {
    redditPostId: id,
    redditFullname: fullname,
    // Conveniência: a ausência não invalida a publicação.
    permalink: criado?.url ?? null,
  }
}
