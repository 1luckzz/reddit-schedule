import { fetch, type Dispatcher } from 'undici'
import { getRedditEnv } from '@/lib/config/env'
import { classifyHttp, classifyNetwork, RedditError } from './errors'
import { readRateLimit } from './ratelimit'
import type { RateLimitSnapshot } from './types'

const API_BASE = 'https://oauth.reddit.com'

export type RedditRequest = {
  path: string
  method?: 'GET' | 'POST'
  form?: Record<string, string>
  query?: Record<string, string>
  /** Marque true em /api/submit, /api/comment e selectflair. */
  hasSideEffect?: boolean
}

export type RedditClient = {
  request<T>(
    req: RedditRequest,
  ): Promise<{ data: T; rateLimit: RateLimitSnapshot }>
}

/**
 * Cliente HTTP do Reddit.
 *
 * `fetch` e `Dispatcher` vêm ambos do pacote `undici` instalado — nunca do
 * fetch global do Node, que usa a instância bundled e não aceita dispatcher
 * de outra instância.
 */
export function createRedditClient(opts: {
  accessToken: string
  dispatcher?: Dispatcher
}): RedditClient {
  return {
    async request<T>(req: RedditRequest) {
      const { REDDIT_USER_AGENT } = getRedditEnv()
      const method = req.method ?? 'GET'
      const hasSideEffect = req.hasSideEffect ?? false

      const url = new URL(API_BASE + req.path)
      for (const [k, v] of Object.entries(req.query ?? {})) {
        url.searchParams.set(k, v)
      }
      // Sem raw_json o Reddit escapa entidades HTML no corpo da resposta.
      url.searchParams.set('raw_json', '1')

      const headers: Record<string, string> = {
        authorization: `bearer ${opts.accessToken}`,
        'user-agent': REDDIT_USER_AGENT,
        accept: 'application/json',
      }

      let body: string | undefined
      if (req.form) {
        body = new URLSearchParams({ ...req.form, api_type: 'json' }).toString()
        headers['content-type'] = 'application/x-www-form-urlencoded'
      }

      // A partir daqui a requisição foi entregue ao transporte: se ela tinha
      // efeito colateral, nenhuma falha posterior é retentável.
      let sideEffectAttempted = false

      let response
      try {
        sideEffectAttempted = hasSideEffect
        response = await fetch(url, {
          method,
          headers,
          body,
          dispatcher: opts.dispatcher,
        })
      } catch (err) {
        throw classifyNetwork(err, sideEffectAttempted)
      }

      const rawHeaders: Record<string, unknown> = {}
      response.headers.forEach((value, key) => {
        rawHeaders[key.toLowerCase()] = value
      })
      const rateLimit = readRateLimit(rawHeaders)

      let payload: unknown = null
      let corpoIlegivel = false
      try {
        const text = await response.text()
        payload = text ? JSON.parse(text) : null
      } catch {
        corpoIlegivel = true
      }

      if (corpoIlegivel && hasSideEffect) {
        throw new RedditError({
          code: 'OUTCOME_UNKNOWN',
          disposition: 'unknown',
          httpStatus: response.status,
          userMessage:
            'O Reddit devolveu uma resposta ilegível. Esta ação precisa de revisão manual.',
        })
      }

      const error = classifyHttp(response.status, payload, hasSideEffect)
      if (error) {
        const retryAfter = Number(rawHeaders['retry-after'])
        if (Number.isFinite(retryAfter)) {
          throw new RedditError({
            code: error.code,
            disposition: error.disposition,
            httpStatus: error.httpStatus,
            userMessage: error.userMessage,
            retryAfterSeconds: Math.trunc(retryAfter),
          })
        }
        throw error
      }

      return { data: payload as T, rateLimit }
    },
  }
}
