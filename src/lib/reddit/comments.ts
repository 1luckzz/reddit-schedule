import type { RedditClient } from './client'
import { RedditError } from './errors'

export type SubmitCommentInput = {
  /** Fullname do post pai, ex.: t3_abc123. */
  thingId: string
  body: string
}

export type CommentResult = {
  redditCommentId: string
  redditFullname: string
  permalink: string | null
}

type CommentResponse = {
  json?: {
    data?: {
      things?: { data?: { id?: string; name?: string; permalink?: string } }[]
    }
  }
}

/**
 * Comenta em uma publicação já existente.
 *
 * Como em submitPost, `hasSideEffect: true` é obrigatório: um comentário
 * duplicado é tão indesejado quanto uma publicação duplicada.
 */
export async function submitComment(
  client: RedditClient,
  input: SubmitCommentInput,
): Promise<CommentResult> {
  const { data } = await client.request<CommentResponse>({
    path: '/api/comment',
    method: 'POST',
    form: { thing_id: input.thingId, text: input.body },
    hasSideEffect: true,
  })

  const thing = data?.json?.data?.things?.[0]?.data
  const id = thing?.id
  const fullname = thing?.name

  if (typeof id !== 'string' || typeof fullname !== 'string') {
    throw new RedditError({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
      userMessage:
        'O Reddit aceitou o comentário mas não devolveu o identificador. É preciso conferir manualmente se ele foi publicado.',
    })
  }

  return {
    redditCommentId: id,
    redditFullname: fullname,
    permalink: typeof thing?.permalink === 'string' ? thing.permalink : null,
  }
}
