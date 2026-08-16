import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/crypto/aes-gcm'
import type { RedditIdentity, RedditTokenResponse } from './types'

export class AccountTakenError extends Error {
  constructor() {
    // Não revela QUEM conectou: isso vazaria informação entre usuários.
    super('Esta conta Reddit já está conectada em outro usuário do painel.')
    this.name = 'AccountTakenError'
  }
}

/**
 * Cria ou reconecta uma conta Reddit. Idempotente por identidade Reddit:
 * reconectar a mesma conta atualiza a linha existente em vez de duplicar.
 *
 * `reddit_user_id` é único globalmente, então NÃO se pode usar upsert cego
 * aqui: um upsert por reddit_user_id sobrescreveria o `owner_id` e
 * transferiria a conta de um usuário do painel para outro. A verificação de
 * dono vem antes.
 */
export async function connectAccount(
  ownerId: string,
  token: RedditTokenResponse,
  identity: RedditIdentity,
): Promise<string> {
  const admin = createAdminSupabase()

  const { data: existente } = await admin
    .from('reddit_accounts')
    .select('id, owner_id')
    .eq('reddit_user_id', identity.id)
    .maybeSingle()

  if (existente && existente.owner_id !== ownerId) {
    throw new AccountTakenError()
  }

  const patch = {
    owner_id: ownerId,
    reddit_user_id: identity.id,
    username: identity.name,
    scopes: token.scope.split(' ').filter(Boolean),
    status: 'connected',
    last_error: null,
    last_authenticated_at: new Date().toISOString(),
  }

  const { data: conta, error } = existente
    ? await admin
        .from('reddit_accounts')
        .update(patch)
        .eq('id', existente.id)
        .select('id')
        .single()
    : await admin.from('reddit_accounts').insert(patch).select('id').single()

  if (error || !conta) throw error ?? new Error('Falha ao gravar a conta.')

  const accountId = conta.id as string

  await admin.from('reddit_account_secrets').upsert(
    {
      reddit_account_id: accountId,
      owner_id: ownerId,
      access_token_enc: encryptSecret(
        token.access_token,
        `reddit_account_secrets:access_token:${accountId}`,
      ),
      refresh_token_enc: encryptSecret(
        token.refresh_token!,
        `reddit_account_secrets:refresh_token:${accountId}`,
      ),
      access_token_expires_at: new Date(
        Date.now() + token.expires_in * 1000,
      ).toISOString(),
      refresh_lock_at: null,
    },
    { onConflict: 'reddit_account_id' },
  )

  return accountId
}
