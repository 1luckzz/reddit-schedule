import 'server-only'
import { requireUser } from '@/lib/auth/require-user'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { decryptSecret } from '@/lib/crypto/aes-gcm'

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
 * Conta cuja posse já foi verificada contra a sessão atual.
 *
 * Isto é defesa de engenharia e ergonomia, NÃO uma fronteira de segurança:
 * tipos do TypeScript somem em tempo de execução e um cast os contorna. A
 * garantia real vem de quatro camadas independentes, todas em runtime:
 * a checagem de posse em assertAccountAccess, a RLS, as constraints e FKs
 * compostas do banco, e os testes A/B com dois usuários reais.
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

/**
 * Porta de entrada obrigatória para qualquer acesso a uma conta Reddit.
 *
 * Consulta com o client do usuário (RLS ativa) e confere o owner_id
 * explicitamente. Só depois disso o client administrativo entra em cena, nas
 * funções abaixo.
 */
export async function assertAccountAccess(
  accountId: string,
): Promise<VerifiedAccount> {
  const user = await requireUser()
  const supabase = await createServerSupabase()

  const { data, error } = await supabase
    .from('reddit_accounts')
    .select(
      'id, owner_id, reddit_user_id, username, scopes, status, min_interval_seconds, last_submit_at',
    )
    .eq('id', accountId)
    .maybeSingle()

  if (error || !data) throw new ForbiddenError()

  // Redundante com a RLS, e de propósito: se uma policy for afrouxada por
  // engano no futuro, esta linha continua barrando.
  if (data.owner_id !== user.id) throw new ForbiddenError()

  return data as VerifiedAccount
}

function aad(column: string, accountId: string) {
  return `reddit_account_secrets:${column}:${accountId}`
}

export async function getAccountSecrets(
  account: VerifiedAccount,
): Promise<AccountSecrets> {
  const admin = createAdminSupabase()
  const { data, error } = await admin
    .from('reddit_account_secrets')
    .select('access_token_enc, refresh_token_enc, access_token_expires_at')
    .eq('reddit_account_id', account.id)
    .single()

  if (error || !data) throw new ForbiddenError()

  return {
    accessToken: decryptSecret(
      data.access_token_enc,
      aad('access_token', account.id),
    ),
    refreshToken: decryptSecret(
      data.refresh_token_enc,
      aad('refresh_token', account.id),
    ),
    expiresAt: new Date(data.access_token_expires_at),
  }
}

export async function getNetworkConfig(
  account: VerifiedAccount,
): Promise<NetworkConfig | null> {
  const admin = createAdminSupabase()
  const { data } = await admin
    .from('reddit_account_network_configs')
    .select(
      'proxy_enabled, proxy_protocol, proxy_host, proxy_port, proxy_username, proxy_password_enc',
    )
    .eq('reddit_account_id', account.id)
    .maybeSingle()

  if (!data || !data.proxy_enabled) return null

  return {
    enabled: true,
    protocol: data.proxy_protocol as NetworkConfig['protocol'],
    host: data.proxy_host as string,
    port: data.proxy_port as number,
    username: data.proxy_username,
    password: data.proxy_password_enc
      ? decryptSecret(
          data.proxy_password_enc,
          `reddit_account_network_configs:proxy_password:${account.id}`,
        )
      : null,
  }
}
