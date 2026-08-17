import 'server-only'
import type { Dispatcher } from 'undici'
import { createAdminSupabase } from '@/lib/supabase/admin'
import {
  assertAccountAccess,
  type VerifiedAccount,
} from '@/lib/auth/ownership'
import { getRedditClientFor, persistTokens as persistTokensCore } from './client-core'
import type { RedditClient } from './client'
import type { RedditTokenResponse } from './types'

// A lógica de montagem do client mora em `client-core.ts`, sem `server-only`,
// porque o worker precisa dela e não pode carregar `next/headers`. Aqui fica o
// caminho do Next: confirmar a posse contra a sessão e delegar.
export { buildProxyUrl, createDispatcherFor } from './client-core'

export async function persistTokens(
  accountId: string,
  token: RedditTokenResponse,
): Promise<void> {
  return persistTokensCore(createAdminSupabase(), accountId, token)
}

/**
 * Caminho do Next: confirma a posse contra a sessão atual e só então monta o
 * client.
 *
 * `skipOwnershipCheck` existe apenas para testes que já montaram o cenário no
 * banco — e mesmo assim o núcleo continua exigindo uma `VerifiedAccount`.
 */
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

  return getRedditClientFor(createAdminSupabase(), verified, {
    dispatcher: opts.dispatcher,
  })
}
