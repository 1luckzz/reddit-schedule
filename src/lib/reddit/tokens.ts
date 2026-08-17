// Troca e renovação de tokens: HTTP puro contra o Reddit, sem banco e sem
// sessão. Fica fora de `auth.ts` — que é `server-only` por causa do state de
// OAuth — para que o worker possa renovar tokens sem carregar aquela árvore.
import { fetch, type Dispatcher } from 'undici'
import { getRedditEnv } from '@/lib/config/env'
import { RedditError } from './errors'
import type { RedditIdentity, RedditTokenResponse } from './types'

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const IDENTITY_URL = 'https://oauth.reddit.com/api/v1/me'

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
