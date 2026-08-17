// Tipos e erro de posse, sem `server-only` e sem dependência de sessão.
//
// Vivem separados de `ownership.ts` porque aquele módulo importa
// `next/headers` — inexistente fora de uma requisição do Next. O worker
// precisa dos mesmos tipos sem poder carregar aquela árvore.

export class ForbiddenError extends Error {
  constructor() {
    super('Conta não encontrada ou sem permissão.')
    this.name = 'ForbiddenError'
  }
}

declare const verified: unique symbol

export type RedditAccount = {
  id: string
  owner_id: string
  reddit_user_id: string
  username: string
  scopes: string[]
  status: 'connected' | 'expired' | 'disconnected' | 'revoked'
  min_interval_seconds: number
  last_submit_at: string | null
}

/**
 * Conta cuja posse já foi verificada — pela sessão, no Next, ou pela coerência
 * de owner garantida no banco, no worker.
 *
 * Isto é defesa de engenharia e ergonomia, NÃO uma fronteira de segurança:
 * tipos do TypeScript somem em tempo de execução e um cast os contorna. A
 * garantia real vem de quatro camadas independentes, todas em runtime:
 * a checagem de posse em assertAccountAccess (ou assertJobConsistency, no
 * worker), a RLS, as constraints e FKs compostas do banco, e os testes A/B com
 * dois usuários reais.
 */
export type VerifiedAccount = RedditAccount & { readonly [verified]: true }

export type AccountSecrets = {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

export type NetworkConfig = {
  enabled: boolean
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username: string | null
  password: string | null
}
