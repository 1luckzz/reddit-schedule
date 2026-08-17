import 'server-only'
import { requireUser } from '@/lib/auth/require-user'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { readAccountSecrets, readNetworkConfig } from '@/lib/reddit/client-core'
import { ForbiddenError } from './ownership-types'
import type {
  AccountSecrets,
  NetworkConfig,
  VerifiedAccount,
} from './ownership-types'

// Reexportados para não obrigar todo chamador a conhecer a separação: os tipos
// moram em ownership-types.ts porque o worker precisa deles sem poder importar
// `next/headers`.
export { ForbiddenError }
export type {
  AccountSecrets,
  NetworkConfig,
  RedditAccount,
  VerifiedAccount,
} from './ownership-types'

/**
 * Porta de entrada obrigatória para qualquer acesso a uma conta Reddit vindo
 * de uma requisição do usuário.
 *
 * Consulta com o client do usuário (RLS ativa) e confere o owner_id
 * explicitamente. Só depois disso o client administrativo entra em cena.
 *
 * No worker não há sessão e esta função não se aplica: lá a posse vem das FKs
 * compostas do banco, reconferidas por `assertJobConsistency`.
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

export async function getAccountSecrets(
  account: VerifiedAccount,
): Promise<AccountSecrets> {
  return readAccountSecrets(createAdminSupabase(), account)
}

export async function getNetworkConfig(
  account: VerifiedAccount,
): Promise<NetworkConfig | null> {
  return readNetworkConfig(createAdminSupabase(), account)
}
