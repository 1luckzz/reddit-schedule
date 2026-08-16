import 'server-only'
import { ProxyAgent, type Dispatcher } from 'undici'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/crypto/aes-gcm'
import {
  assertAccountAccess,
  getAccountSecrets,
  getNetworkConfig,
  type NetworkConfig,
  type VerifiedAccount,
} from '@/lib/auth/ownership'
import { refreshAccessToken } from './auth'
import { createRedditClient, type RedditClient } from './client'
import { RedditError } from './errors'
import type { RedditTokenResponse } from './types'

const REFRESH_MARGIN_MS = 120_000
const REFRESH_LOCK_MS = 30_000

/**
 * Monta a URL do proxy. Nunca logue o resultado: use a forma mascarada.
 * O sanitizador de logs redige este formato, mas não confie nisso como
 * primeira linha de defesa.
 */
export function buildProxyUrl(config: NetworkConfig): string {
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(
        config.password ?? '',
      )}@`
    : ''
  return `${config.protocol}://${auth}${config.host}:${config.port}`
}

/**
 * Dispatcher da conta. Sem configuração de rede, devolve undefined e o undici
 * usa o dispatcher global.
 *
 * A configuração é fixa por conta: não há pool, rotação, nem troca de rota
 * após erro. `proxyTls` existe para proxies HTTPS com certificado próprio.
 */
export function createDispatcherFor(
  config: NetworkConfig | null,
  opts: { proxyTls?: { ca?: string | string[]; rejectUnauthorized?: boolean } } = {},
): Dispatcher | undefined {
  if (!config) return undefined
  return new ProxyAgent({
    uri: buildProxyUrl(config),
    ...(opts.proxyTls ? { proxyTls: opts.proxyTls } : {}),
  })
}

export async function persistTokens(
  accountId: string,
  token: RedditTokenResponse,
): Promise<void> {
  const admin = createAdminSupabase()
  const patch: Record<string, unknown> = {
    access_token_enc: encryptSecret(
      token.access_token,
      `reddit_account_secrets:access_token:${accountId}`,
    ),
    access_token_expires_at: new Date(
      Date.now() + token.expires_in * 1000,
    ).toISOString(),
    refresh_lock_at: null,
  }

  // O Reddit só devolve refresh_token na troca inicial; num refresh comum a
  // ausência é normal e o token antigo continua valendo.
  if (token.refresh_token) {
    patch.refresh_token_enc = encryptSecret(
      token.refresh_token,
      `reddit_account_secrets:refresh_token:${accountId}`,
    )
  }

  await admin
    .from('reddit_account_secrets')
    .update(patch)
    .eq('reddit_account_id', accountId)
}

async function markDisconnected(accountId: string, code: string) {
  const admin = createAdminSupabase()
  await admin
    .from('reddit_accounts')
    .update({
      status: 'disconnected',
      // Apenas o código do erro: nada de corpo de resposta ou token.
      last_error: code,
    })
    .eq('id', accountId)
}

/** Tenta tomar o lock de refresh. Falso significa "outro já está renovando". */
async function acquireRefreshLock(accountId: string): Promise<boolean> {
  const admin = createAdminSupabase()
  const cutoff = new Date(Date.now() - REFRESH_LOCK_MS).toISOString()
  const { data } = await admin
    .from('reddit_account_secrets')
    .update({ refresh_lock_at: new Date().toISOString() })
    .eq('reddit_account_id', accountId)
    .or(`refresh_lock_at.is.null,refresh_lock_at.lt.${cutoff}`)
    .select('reddit_account_id')
  return (data?.length ?? 0) === 1
}

export async function getRedditClient(
  account: VerifiedAccount,
  opts: {
    dispatcher?: Dispatcher
    /** Somente para testes que já montaram o cenário no banco. */
    skipOwnershipCheck?: boolean
  } = {},
): Promise<RedditClient> {
  const verified = opts.skipOwnershipCheck
    ? account
    : await assertAccountAccess(account.id)

  let secrets = await getAccountSecrets(verified)

  const precisaRenovar =
    secrets.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS

  if (precisaRenovar) {
    const gotLock = await acquireRefreshLock(verified.id)
    if (gotLock) {
      try {
        const token = await refreshAccessToken(
          secrets.refreshToken,
          opts.dispatcher,
        )
        await persistTokens(verified.id, token)
        secrets = await getAccountSecrets(verified)
      } catch (e) {
        if (e instanceof RedditError && e.code === 'REFRESH_INVALID') {
          await markDisconnected(verified.id, e.code)
        }
        throw e
      }
    } else {
      // Outro processo está renovando: relê o segredo já atualizado.
      secrets = await getAccountSecrets(verified)
    }
  }

  const dispatcher =
    opts.dispatcher ?? createDispatcherFor(await getNetworkConfig(verified))

  return createRedditClient({ accessToken: secrets.accessToken, dispatcher })
}
