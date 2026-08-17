import type { Dispatcher } from 'undici'
import { workerServiceClient } from './supabase'
import { getRedditClientFor } from '@/lib/reddit/client-core'
import { getPostRequirements } from '@/lib/reddit/requirements'
import { buildPayload, PayloadError } from '@/lib/scheduling/payload-builder'
import { submitPost } from '@/lib/reddit/posts'
import { RedditError } from '@/lib/reddit/errors'
import { loadAccountForWorker } from '@/lib/worker/load-account'
import { assertJobConsistency } from '@/lib/worker/consistency'
import { logExecution } from '@/lib/worker/log'
import { MAX_RETRIES, nextAttemptAt } from '@/lib/worker/retry'

export type PostJob = {
  id: string
  owner_id: string
  reddit_account_id: string
  subreddit_id: string
  title: string
  url: string | null
  body: string | null
  post_kind: 'link' | 'self'
  flair_id: string | null
  nsfw: boolean
  spoiler: boolean
  retry_count: number
}

export type PostOutcome = 'published' | 'retry' | 'failed' | 'needs_review'

export type RunResult = {
  outcome: PostOutcome
  /** O erro capturado, para os testes conferirem a classificação. */
  erro?: unknown
}

/**
 * Publica um job já reivindicado.
 *
 * A ordem dos passos é a parte que importa:
 *   1. carregar conta e comunidade;
 *   2. `assertJobConsistency` — defesa em profundidade;
 *   3. revalidar requisitos, porque a comunidade pode ter mudado as regras
 *      desde o agendamento;
 *   4. gravar e commitar `submit_attempted_at` — o ponto sem volta;
 *   5. enviar;
 *   6. gravar o resultado e materializar o horário dos comentários.
 *
 * Entre 4 e 6 está a janela de incerteza. O passo 4 custa um round-trip a mais
 * ao banco, e é o que permite ao reaper distinguir "nunca saiu" de "pode ter
 * chegado".
 */
export async function runPost(
  job: PostJob,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<RunResult> {
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
      scheduledPostId: job.id,
      action: 'submit_post',
      outcome,
      durationMs: Date.now() - inicio,
      ...extra,
    })

  /** Libera o lock e registra o desfecho. */
  const finalizar = async (patch: Record<string, unknown>) => {
    await service
      .from('scheduled_posts')
      .update({ locked_at: null, locked_by: null, ...patch })
      .eq('id', job.id)
  }

  try {
    // --- 1 e 2: conta, comunidade e coerência ---
    const account = await loadAccountForWorker(service, job.reddit_account_id)

    const { data: subreddit } = await service
      .from('subreddits')
      .select(
        'id, name, owner_id, reddit_account_id, submission_type, link_flair_enabled',
      )
      .eq('id', job.subreddit_id)
      .single()

    if (!subreddit) throw new Error('Comunidade não encontrada.')

    assertJobConsistency({
      postOwnerId: job.owner_id,
      accountOwnerId: account.owner_id,
      subredditOwnerId: subreddit.owner_id as string,
      postAccountId: job.reddit_account_id,
      subredditAccountId: subreddit.reddit_account_id as string,
    })

    // No worker a posse não vem de sessão: vem das FKs compostas do banco,
    // reconferidas logo acima. Por isso o núcleo, e não o factory do Next.
    const client = await getRedditClientFor(service, account, {
      dispatcher: opts.dispatcher,
    })

    // --- 3: requisitos podem ter mudado desde o agendamento ---
    const requirements = await getPostRequirements(
      client,
      subreddit.name as string,
    )

    const payload = buildPayload(
      {
        title: job.title,
        url: job.url ?? undefined,
        body: job.body ?? undefined,
        flairId: job.flair_id ?? undefined,
        nsfw: job.nsfw,
        spoiler: job.spoiler,
        // O redirecionamento de texto para comentário já foi decidido no
        // agendamento; aqui ele não pode surpreender o usuário.
        allowCommentFallback: true,
      },
      requirements,
      {
        name: subreddit.name as string,
        submissionType:
          (subreddit.submission_type as 'any' | 'link' | 'self') ?? 'any',
        linkFlairEnabled: Boolean(subreddit.link_flair_enabled),
      },
    )

    // --- 4: o ponto sem volta ---
    // Gravado e commitado ANTES do envio: é o que permite ao reaper saber que
    // a requisição pode ter chegado ao Reddit.
    await service
      .from('scheduled_posts')
      .update({ submit_attempted_at: new Date().toISOString() })
      .eq('id', job.id)

    // --- 5: enviar ---
    const resultado = await submitPost(client, {
      subredditName: subreddit.name as string,
      postKind: payload.postKind,
      title: payload.title,
      url: payload.url,
      body: payload.body,
      flairId: payload.flairId,
      nsfw: payload.nsfw,
      spoiler: payload.spoiler,
    })

    // --- 6: gravar resultado ---
    const publishedAt = new Date().toISOString()
    await finalizar({
      status: 'published',
      reddit_post_id: resultado.redditPostId,
      reddit_fullname: resultado.redditFullname,
      reddit_permalink: resultado.permalink,
      published_at: publishedAt,
      error_code: null,
      error_message: null,
      next_attempt_at: null,
    })

    // Espaçamento entre publicações da mesma conta.
    await service
      .from('reddit_accounts')
      .update({ last_submit_at: publishedAt })
      .eq('id', account.id)

    // Comentários em modo immediate/delay só agora ganham horário.
    await service.rpc('materialize_comment_schedule', {
      p_post_id: job.id,
      p_published_at: publishedAt,
    })

    await log('success', { httpStatus: 200 })
    return { outcome: 'published' }
  } catch (e) {
    // --- resultado desconhecido: nunca retentar ---
    if (e instanceof RedditError && e.disposition === 'unknown') {
      await finalizar({
        status: 'needs_review',
        review_reason: e.code,
        error_code: e.code,
        error_message: e.userMessage,
        next_attempt_at: null,
        // NÃO limpo: é o registro de que algo pode ter saído. Apagá-lo
        // autorizaria uma segunda publicação.
      })
      await log('unknown', { errorCode: e.code, errorMessage: e.userMessage })
      return { outcome: 'needs_review', erro: e }
    }

    // --- retentável E seguro repetir ---
    // As duas condições são necessárias: `retryable` diz que vale a pena
    // tentar; `safeToRetryEffect` diz que repetir não arrisca publicar duas
    // vezes. Só com as duas o job volta à fila com submit_attempted_at limpo.
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
          // Limpo: o job não vai mais ser tentado.
          submit_attempted_at: null,
        })
        await log('failure', { errorCode: e.code, errorMessage: e.userMessage })
        return { outcome: 'failed', erro: e }
      }

      // Duas escritas, e não uma, por causa de `enforce_post_transition`: o
      // trigger recusa `processing -> scheduled` enquanto `submit_attempted_at`
      // estiver preenchido. A regra dele é a do reaper, que não sabe o que
      // aconteceu; aqui nós sabemos — temos o erro classificado em mãos e
      // `safeToRetryEffect` afirma que nada saiu.
      //
      // Separar em dois passos preserva a invariante em vez de afrouxá-la, e a
      // janela entre eles é segura: se o worker morrer no meio, o job fica em
      // `processing` com o campo já limpo, que é exatamente o estado que o
      // reaper devolve à fila.
      await service
        .from('scheduled_posts')
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

    // --- retentável mas SEM garantia de segurança: ambíguo ---
    // "Vale a pena tentar, mas não sabemos se já teve efeito" é exatamente a
    // definição de resultado ambíguo, e vai para revisão humana.
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

    // --- terminal, inclusive erros locais ---
    const codigo =
      e instanceof RedditError
        ? e.code
        : e instanceof PayloadError
          ? 'PAYLOAD_INVALID'
          : 'INTERNAL_ERROR'
    const mensagem =
      e instanceof RedditError
        ? e.userMessage
        : e instanceof PayloadError
          ? e.userMessage
          : 'Não foi possível publicar por um erro interno.'

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
