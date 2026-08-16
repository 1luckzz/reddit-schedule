import type { RedditApiEnvelope } from './types'

export type Disposition = 'retryable' | 'unknown' | 'terminal'

export class RedditError extends Error {
  readonly code: string
  readonly disposition: Disposition
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
  readonly userMessage: string

  constructor(init: {
    code: string
    disposition: Disposition
    userMessage: string
    httpStatus?: number
    retryAfterSeconds?: number
  }) {
    super(`${init.code} (${init.disposition})`)
    this.name = 'RedditError'
    this.code = init.code
    this.disposition = init.disposition
    this.httpStatus = init.httpStatus
    this.retryAfterSeconds = init.retryAfterSeconds
    this.userMessage = init.userMessage
  }
}

/**
 * Classifica uma resposta HTTP do Reddit.
 *
 * `hasSideEffect` marca requisições que podem ter alterado estado
 * (/api/submit, /api/comment, selectflair). Para elas, qualquer 5xx é
 * ambíguo: não existe documentação oficial do Reddit garantindo que um POST
 * respondido com 5xx não produziu efeito, e um gateway pode falhar depois do
 * upstream processar. Preferimos revisão humana a uma publicação duplicada.
 */
export function classifyHttp(
  status: number,
  body: unknown,
  hasSideEffect: boolean,
): RedditError | null {
  if (status === 401) {
    return new RedditError({
      code: 'TOKEN_INVALID',
      disposition: 'terminal',
      httpStatus: status,
      userMessage:
        'A autorização desta conta expirou. Reconecte a conta para continuar.',
    })
  }

  if (status === 403) {
    return new RedditError({
      code: 'NO_PERMISSION',
      disposition: 'terminal',
      httpStatus: status,
      userMessage:
        'Sua conta não possui mais permissão para essa ação nessa comunidade.',
    })
  }

  if (status === 404) {
    return new RedditError({
      code: 'NOT_FOUND',
      disposition: 'terminal',
      httpStatus: status,
      userMessage: 'A comunidade ou o conteúdo informado não foi encontrado.',
    })
  }

  if (status === 429) {
    return new RedditError({
      code: 'RATE_LIMITED',
      disposition: 'retryable',
      httpStatus: status,
      userMessage:
        'O Reddit pediu para aguardar antes de novas requisições. A ação será retomada automaticamente.',
    })
  }

  if (status >= 500) {
    return new RedditError({
      code: hasSideEffect ? 'OUTCOME_UNKNOWN' : 'REDDIT_UNAVAILABLE',
      disposition: hasSideEffect ? 'unknown' : 'retryable',
      httpStatus: status,
      userMessage: hasSideEffect
        ? 'O Reddit não confirmou o resultado desta ação. Ela precisa de revisão manual antes de qualquer nova tentativa.'
        : 'O Reddit está indisponível no momento. Vamos tentar de novo.',
    })
  }

  if (status >= 400) {
    return new RedditError({
      code: 'BAD_REQUEST',
      disposition: 'terminal',
      httpStatus: status,
      userMessage: 'O Reddit recusou os dados enviados.',
    })
  }

  // 2xx ainda pode carregar erro no corpo: o Reddit responde 200 com
  // json.errors quando rejeita o conteúdo.
  const envelope = body as RedditApiEnvelope
  const errors = envelope?.json?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const [code, message] = errors[0]
    return new RedditError({
      code: `CONTENT_REJECTED:${code}`,
      disposition: 'terminal',
      httpStatus: status,
      userMessage: `O Reddit recusou a publicação: ${message}`,
    })
  }

  return null
}

const PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UND_ERR_PROXY',
])

/**
 * Classifica uma falha de rede.
 *
 * `sideEffectAttempted` é verdadeiro a partir do momento em que a requisição
 * de efeito foi entregue à camada de transporte. Depois disso, nenhum erro de
 * rede é retentável: não há como saber se o Reddit processou o pedido.
 */
export function classifyNetwork(
  err: unknown,
  sideEffectAttempted: boolean,
): RedditError {
  const code = (err as { code?: string })?.code ?? 'NETWORK_ERROR'
  const isProxy = code === 'UND_ERR_PROXY'

  if (sideEffectAttempted) {
    return new RedditError({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
      userMessage:
        'A conexão caiu depois do envio e o resultado é desconhecido. Esta ação precisa de revisão manual.',
    })
  }

  if (PRE_SEND_CODES.has(code)) {
    return new RedditError({
      code: isProxy ? 'PROXY_UNAVAILABLE' : 'NETWORK_ERROR',
      disposition: 'retryable',
      userMessage: isProxy
        ? 'A configuração de rede desta conta está indisponível. Vamos tentar de novo.'
        : 'Não foi possível alcançar o Reddit. Vamos tentar de novo.',
    })
  }

  // Código desconhecido e requisição sem efeito: retentar é seguro.
  return new RedditError({
    code: 'NETWORK_ERROR',
    disposition: 'retryable',
    userMessage: 'Falha de rede ao falar com o Reddit. Vamos tentar de novo.',
  })
}
