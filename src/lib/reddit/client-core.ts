// Sem `server-only`: este módulo roda no Next E no worker.
// Sem `next/headers`, sem `requireUser`, sem `process.env`.
import type { SupabaseClient } from '@supabase/supabase-js'
import { ProxyAgent, type Dispatcher } from 'undici'
import { decryptSecret, encryptSecret } from '@/lib/crypto/aes-gcm'
import { ForbiddenError } from '@/lib/auth/ownership-types'
import type {
  AccountSecrets,
  NetworkConfig,
  VerifiedAccount,
} from '@/lib/auth/ownership-types'
import { refreshAccessToken } from './tokens'
import { reconcileBudgetWith, reserveBudgetWith } from './budget-core'
import { createRedditClient, type RedditClient } from './client'
import { RedditError } from './errors'
import type { RedditTokenResponse } from './types'

const REFRESH_MARGIN_MS = 120_000
const REFRESH_LOCK_MS = 30_000

function aad(column: string, accountId: string) {
  return `reddit_account_secrets:${column}:${accountId}`
}

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
  opts: {
    proxyTls?: { ca?: string | string[]; rejectUnauthorized?: boolean }
  } = {},
): Dispatcher | undefined {
  if (!config) return undefined
  return new ProxyAgent({
    uri: buildProxyUrl(config),
    ...(opts.proxyTls ? { proxyTls: opts.proxyTls } : {}),
  })
}

/**
 * Segredos da conta, decifrados.
 *
 * O AAD amarra cada valor à sua coluna e ao id da conta: mover um ciphertext
 * de uma conta para outra faz a decifragem falhar em vez de entregar o token
 * errado.
 */
export async function readAccountSecrets(
  service: SupabaseClient,
  account: VerifiedAccount,
): Promise<AccountSecrets> {
  const { data, error } = await service
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

export async function readNetworkConfig(
  service: SupabaseClient,
  account: VerifiedAccount,
): Promise<NetworkConfig | null> {
  const { data } = await service
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

export async function persistTokens(
  service: SupabaseClient,
  accountId: string,
  token: RedditTokenResponse,
): Promise<void> {
  const patch: Record<string, unknown> = {
    access_token_enc: encryptSecret(
      token.access_token,
      aad('access_token', accountId),
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
      aad('refresh_token', accountId),
    )
  }

  await service
    .from('reddit_account_secrets')
    .update(patch)
    .eq('reddit_account_id', accountId)
}

async function markDisconnected(
  service: SupabaseClient,
  accountId: string,
  code: string,
) {
  await service
    .from('reddit_accounts')
    .update({
      status: 'disconnected',
      // Apenas o código do erro: nada de corpo de resposta ou token.
      last_error: code,
    })
    .eq('id', accountId)
}

/** Tenta tomar o lock de refresh. Falso significa "outro já está renovando". */
async function acquireRefreshLock(
  service: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - REFRESH_LOCK_MS).toISOString()
  const { data } = await service
    .from('reddit_account_secrets')
    .update({ refresh_lock_at: new Date().toISOString() })
    .eq('reddit_account_id', accountId)
    .or(`refresh_lock_at.is.null,refresh_lock_at.lt.${cutoff}`)
    .select('reddit_account_id')
  return (data?.length ?? 0) === 1
}

/**
 * Monta o client de uma conta **cuja posse já foi verificada pelo chamador**.
 *
 * No Next quem verifica é `assertAccountAccess`, contra a sessão. No worker não
 * existe sessão: a garantia vem das FKs compostas do banco mais
 * `assertJobConsistency`. Este núcleo não escolhe entre as duas — exige que uma
 * delas já tenha acontecido, e o tipo `VerifiedAccount` é o que registra isso.
 */
export async function getRedditClientFor(
  service: SupabaseClient,
  account: VerifiedAccount,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<RedditClient> {
  let secrets = await readAccountSecrets(service, account)

  const precisaRenovar =
    secrets.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS

  if (precisaRenovar) {
    const gotLock = await acquireRefreshLock(service, account.id)
    if (gotLock) {
      try {
        const token = await refreshAccessToken(
          secrets.refreshToken,
          opts.dispatcher,
        )
        await persistTokens(service, account.id, token)
        secrets = await readAccountSecrets(service, account)
      } catch (e) {
        if (e instanceof RedditError && e.code === 'REFRESH_INVALID') {
          await markDisconnected(service, account.id, e.code)
        }
        throw e
      }
    } else {
      // Outro processo está renovando: relê o segredo já atualizado.
      secrets = await readAccountSecrets(service, account)
    }
  }

  const dispatcher =
    opts.dispatcher ??
    createDispatcherFor(await readNetworkConfig(service, account))

  return createRedditClient({
    accessToken: secrets.accessToken,
    dispatcher,
    // O mesmo controle de orcamento do Next, com o client deste lado.
    onBeforeRequest: () => reserveBudgetWith(service),
    onAfterRequest: (snapshot) => reconcileBudgetWith(service, snapshot),
  })
}
