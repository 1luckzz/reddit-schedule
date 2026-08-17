import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { getRedditEnv } from '@/lib/config/env'
import { createAdminSupabase } from '@/lib/supabase/admin'

// A troca de tokens em si mora em `tokens.ts`, sem `server-only`, para que o
// worker possa renovar sem carregar o state de OAuth — que depende de banco e
// de cookie e não faz sentido fora de uma requisição.
export {
  exchangeCode,
  fetchIdentity,
  refreshAccessToken,
} from './tokens'

const AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize'
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
