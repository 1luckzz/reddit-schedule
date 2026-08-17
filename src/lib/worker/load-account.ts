import type { SupabaseClient } from '@supabase/supabase-js'
import type { VerifiedAccount } from '@/lib/auth/ownership-types'

export class AccountUnavailableError extends Error {
  constructor(status: string) {
    super(`A conta não está disponível para publicar (situação: ${status}).`)
    this.name = 'AccountUnavailableError'
  }
}

/**
 * Carrega a conta de um job para o worker.
 *
 * Recebe o client em vez de criá-lo: assim este módulo — e todo o resto de
 * `src/lib/worker/` — nunca precisa conhecer a chave secreta.
 *
 * No worker não existe sessão: a autorização vem de o job já estar no banco
 * com owner_id coerente, garantido por FKs compostas e reconferido por
 * `assertJobConsistency`. Por isso o tipo VerifiedAccount é produzido aqui sem
 * passar por `assertAccountAccess`, que depende de requisição HTTP.
 */
export async function loadAccountForWorker(
  service: SupabaseClient,
  accountId: string,
): Promise<VerifiedAccount> {
  const { data, error } = await service
    .from('reddit_accounts')
    .select(
      'id, owner_id, reddit_user_id, username, scopes, status, min_interval_seconds, last_submit_at',
    )
    .eq('id', accountId)
    .single()

  if (error || !data) {
    throw new AccountUnavailableError('não encontrada')
  }
  if (data.status !== 'connected') {
    throw new AccountUnavailableError(data.status)
  }

  return data as VerifiedAccount
}
