import type { Dispatcher } from 'undici'
import { workerServiceClient } from './supabase'
import { getRedditClientFor } from '@/lib/reddit/client-core'
import { submitComment } from '@/lib/reddit/comments'
import { RedditError } from '@/lib/reddit/errors'
import { sanitize } from '@/lib/logging/sanitize'
import { loadAccountForWorker } from '@/lib/worker/load-account'
import { logExecution } from '@/lib/worker/log'
import { MAX_RETRIES, nextAttemptAt } from '@/lib/worker/retry'

export type CommentJob = {
  id: string
  owner_id: string
  scheduled_post_id: string
  reddit_account_id: string
  body: string
  retry_count: number
}

export type CommentOutcome = 'published' | 'retry' | 'failed' | 'needs_review'

export type RunCommentResult = {
  outcome: CommentOutcome
  erro?: unknown
}

/**
 * Publica um comentário já reivindicado.
 *
 * Mesmo desenho do runner de publicação, com uma diferença: o comentário
 * depende do `reddit_fullname` do post pai. `claim_due_comments` já garante
 * isso, e o runner reconfere antes de enviar — entre o claim e o envio o post
 * pode ter sido resolvido manualmente como falho.
 */
export async function runComment(
  job: CommentJob,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<RunCommentResult> {
  const service = workerServiceClient()
  const inicio = Date.now()

  const log = (
    outcome: 'success' | 'failure' | 'retry' | 'unknown',
    extra: {
      errorCode?: string
      errorMessage?: string
      httpStatus?: number
    } = {},
  ) =>
    logExecution(service, {
      ownerId: job.owner_id,
      redditAccountId: job.reddit_account_id,
      scheduledPostId: job.scheduled_post_id,
      scheduledCommentId: job.id,
      action: 'submit_comment',
      outcome,
      durationMs: Date.now() - inicio,
      ...extra,
    })

  /**
   * Libera o lock e registra o desfecho.
   *
   * O erro é conferido pelo mesmo motivo do runner de publicação: o
   * supabase-js devolve falhas em `error` em vez de lançar, e uma gravação
   * silenciosamente perdida faria o runner relatar sucesso com o job preso
   * em `processing`.
   */
  const finalizar = async (patch: Record<string, unknown>) => {
    const { error } = await service
      .from('scheduled_comments')
      .update({ locked_at: null, locked_by: null, ...patch })
      .eq('id', job.id)
    if (error) {
      console.error(
        `worker: falha ao gravar desfecho do comentário ${job.id}`,
        sanitize(error.message),
      )
    }
  }

  try {
    const account = await loadAccountForWorker(service, job.reddit_account_id)

    const { data: post } = await service
      .from('scheduled_posts')
      .select('id, owner_id, reddit_account_id, status, reddit_fullname')
      .eq('id', job.scheduled_post_id)
      .single()

    if (!post) throw new Error('Publicação de origem não encontrada.')

    // Coerência de posse: a mesma defesa em profundidade do runner de post.
    // As FKs compostas já garantem, mas o comentário sai em nome de alguém.
    if (
      post.owner_id !== job.owner_id ||
      post.owner_id !== account.owner_id ||
      post.reddit_account_id !== job.reddit_account_id
    ) {
      throw new Error('Comentário com vínculos inconsistentes.')
    }

    // Reconferido aqui e não só no claim: entre um e outro o post pode ter
    // sido resolvido manualmente como falho ou cancelado.
    if (post.status !== 'published' || !post.reddit_fullname) {
      throw new Error(
        'A publicação de origem não está no Reddit; o comentário não tem onde ser feito.',
      )
    }

    const client = await getRedditClientFor(service, account, {
      dispatcher: opts.dispatcher,
    })

    // O ponto sem volta, pelo mesmo motivo do runner de publicação.
    await service
      .from('scheduled_comments')
      .update({ submit_attempted_at: new Date().toISOString() })
      .eq('id', job.id)

    const resultado = await submitComment(client, {
      thingId: post.reddit_fullname as string,
      body: job.body,
    })

    const publishedAt = new Date().toISOString()
    await finalizar({
      status: 'published',
      reddit_comment_id: resultado.redditCommentId,
      reddit_permalink: resultado.permalink,
      published_at: publishedAt,
      error_code: null,
      error_message: null,
      next_attempt_at: null,
    })

    await log('success', { httpStatus: 200 })
    return { outcome: 'published' }
  } catch (e) {
    if (e instanceof RedditError && e.disposition === 'unknown') {
      await finalizar({
        status: 'needs_review',
        review_reason: e.code,
        error_code: e.code,
        error_message: e.userMessage,
        next_attempt_at: null,
        // Preservado: um comentário duplicado é tão indesejado quanto uma
        // publicação duplicada.
      })
      await log('unknown', { errorCode: e.code, errorMessage: e.userMessage })
      return { outcome: 'needs_review', erro: e }
    }

    if (
      e instanceof RedditError &&
      e.disposition === 'retryable' &&
      e.safeToRetryEffect
    ) {
      const tentativas = job.retry_count + 1
      if (tentativas > MAX_RETRIES) {
        await finalizar({
          status: 'failed',
          retry_count: tentativas,
          error_code: e.code,
          error_message: e.userMessage,
          submit_attempted_at: null,
        })
        await log('failure', { errorCode: e.code, errorMessage: e.userMessage })
        return { outcome: 'failed', erro: e }
      }

      // Duas escritas pelo mesmo motivo do runner de publicação:
      // `enforce_comment_transition` recusa processing -> scheduled enquanto
      // submit_attempted_at estiver preenchido.
      await service
        .from('scheduled_comments')
        .update({ submit_attempted_at: null })
        .eq('id', job.id)

      await finalizar({
        status: 'scheduled',
        retry_count: tentativas,
        next_attempt_at: nextAttemptAt(
          job.retry_count,
          e.retryAfterSeconds,
        ).toISOString(),
        error_code: e.code,
        error_message: e.userMessage,
      })
      await log('retry', { errorCode: e.code, errorMessage: e.userMessage })
      return { outcome: 'retry', erro: e }
    }

    // Retentável sem garantia de segurança é ambíguo: revisão humana.
    if (e instanceof RedditError && e.disposition === 'retryable') {
      await finalizar({
        status: 'needs_review',
        review_reason: e.code,
        error_code: e.code,
        error_message: e.userMessage,
        next_attempt_at: null,
      })
      await log('unknown', { errorCode: e.code, errorMessage: e.userMessage })
      return { outcome: 'needs_review', erro: e }
    }

    const codigo = e instanceof RedditError ? e.code : 'INTERNAL_ERROR'
    const mensagem =
      e instanceof RedditError
        ? e.userMessage
        : ((e as Error)?.message ??
          'Não foi possível comentar por um erro interno.')

    await finalizar({
      status: 'failed',
      error_code: codigo,
      error_message: mensagem,
      submit_attempted_at: null,
    })
    await log('failure', { errorCode: codigo, errorMessage: mensagem })
    return { outcome: 'failed', erro: e }
  }
}
