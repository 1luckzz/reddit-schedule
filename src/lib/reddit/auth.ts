import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { fetch, type Dispatcher } from 'undici'
import { getRedditEnv } from '@/lib/config/env'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { RedditError } from './errors'
import type { RedditIdentity, RedditTokenResponse } from './types'

const AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize'
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const IDENTITY_URL = 'https://oauth.reddit.com/api/v1/me'
const STATE_TTL_SECONDS = 600

export const REDDIT_SCOPES = [
  'identity',
  'mysubreddits',
  'submit',
  'read',
  'flair',
  'edit',
  'history',
] as const

export const STATE_COOKIE = 'reddit_oauth_state'

export class OAuthStateError extends Error {
  constructor() {
    // Mensagem única para todos os motivos: não informa a quem tenta adivinhar
    // se o state existia, expirou ou pertencia a outra sessão.
    super('Não foi possível validar a solicitação. Tente conectar novamente.')
    this.name = 'OAuthStateError'
  }
}

const hashState = (value: string) =>
  createHash('sha256').update(value).digest('hex')

export function buildAuthorizeUrl(state: string): string {
  const env = getRedditEnv()
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', env.REDDIT_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', env.REDDIT_REDIRECT_URI)
  // duration=permanent é o que faz o Reddit devolver refresh token.
  url.searchParams.set('duration', 'permanent')
  url.searchParams.set('scope', REDDIT_SCOPES.join(' '))
  return url.toString()
}

export async function createOAuthState(ownerId: string) {
  const value = randomBytes(32).toString('base64url')
  const admin = createAdminSupabase()

  const { error } = await admin.from('oauth_states').insert({
    owner_id: ownerId,
    state_hash: hashState(value),
    expires_at: new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString(),
  })
  if (error) throw new OAuthStateError()

  return {
    value,
    cookie: {
      name: STATE_COOKIE,
      value,
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/api/reddit',
      maxAge: STATE_TTL_SECONDS,
    },
  }
}

/**
 * Consome o state. O UPDATE condicional é a própria trava contra replay:
 * a segunda tentativa não encontra linha para atualizar.
 */
export async function consumeOAuthState(
  value: string,
  ownerId: string,
): Promise<void> {
  const admin = createAdminSupabase()
  const { data, error } = await admin
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state_hash', hashState(value))
    .eq('owner_id', ownerId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')

  if (error || !data || data.length !== 1) throw new OAuthStateError()
}

function basicAuth(): string {
  const env = getRedditEnv()
  const raw = `${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`
  return 'Basic ' + Buffer.from(raw).toString('base64')
}

async function requestToken(
  form: Record<string, string>,
  invalidCode: string,
  dispatcher?: Dispatcher,
): Promise<RedditTokenResponse> {
  const env = getRedditEnv()
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuth(),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': env.REDDIT_USER_AGENT,
    },
    body: new URLSearchParams(form).toString(),
    dispatcher,
  })

  if (!response.ok) {
    // O corpo é descartado de propósito: ele pode ecoar o que enviamos.
    throw new RedditError({
      code: invalidCode,
      disposition: 'terminal',
      httpStatus: response.status,
      userMessage:
        'O Reddit recusou a autorização desta conta. Conecte a conta novamente.',
    })
  }

  return (await response.json()) as RedditTokenResponse
}

export async function exchangeCode(
  code: string,
  dispatcher?: Dispatcher,
): Promise<RedditTokenResponse> {
  const env = getRedditEnv()
  const token = await requestToken(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.REDDIT_REDIRECT_URI,
    },
    'OAUTH_EXCHANGE_FAILED',
    dispatcher,
  )

  if (!token.refresh_token) {
    throw new RedditError({
      code: 'NO_REFRESH_TOKEN',
      disposition: 'terminal',
      userMessage:
        'O Reddit não devolveu autorização permanente. Refaça a conexão da conta.',
    })
  }

  return token
}

export async function refreshAccessToken(
  refreshToken: string,
  dispatcher?: Dispatcher,
): Promise<RedditTokenResponse> {
  return requestToken(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    'REFRESH_INVALID',
    dispatcher,
  )
}

export async function fetchIdentity(
  accessToken: string,
  dispatcher?: Dispatcher,
): Promise<RedditIdentity> {
  const env = getRedditEnv()
  const response = await fetch(IDENTITY_URL, {
    headers: {
      authorization: `bearer ${accessToken}`,
      'user-agent': env.REDDIT_USER_AGENT,
    },
    dispatcher,
  })

  if (!response.ok) {
    throw new RedditError({
      code: 'IDENTITY_FAILED',
      disposition: 'terminal',
      httpStatus: response.status,
      userMessage: 'Não foi possível confirmar a identidade da conta no Reddit.',
    })
  }

  const me = (await response.json()) as { id: string; name: string }
  return { id: me.id, name: me.name }
}
