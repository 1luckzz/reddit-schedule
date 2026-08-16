import 'server-only'
import type { Dispatcher } from 'undici'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { VerifiedAccount } from '@/lib/auth/ownership'
import { getRedditClient } from './reddit-client-factory'
import { listModeratedSubreddits } from './communities'

export type SyncResult = {
  criadas: number
  atualizadas: number
  removidas: number
  total: number
}

/**
 * Sincroniza as comunidades que a conta modera.
 *
 * A listagem completa vem primeiro e só então o banco é tocado: se a API
 * falhar no meio da paginação, nada é gravado e o estado anterior permanece
 * íntegro.
 *
 * A reserva de orçamento acontece por requisição, dentro do cliente; aqui só
 * deixamos o erro subir para a server action.
 */
export async function syncCommunitiesFor(
  account: VerifiedAccount,
  opts: { dispatcher?: Dispatcher; skipOwnershipCheck?: boolean } = {},
): Promise<SyncResult> {
  const client = await getRedditClient(account, opts)
  const remotas = await listModeratedSubreddits(client)

  const admin = createAdminSupabase()
  const agora = new Date().toISOString()

  const { data: existentes } = await admin
    .from('subreddits')
    .select('id, subreddit_fullname, status')
    .eq('reddit_account_id', account.id)

  const porFullname = new Map(
    (existentes ?? []).map((s) => [s.subreddit_fullname as string, s]),
  )

  let criadas = 0
  let atualizadas = 0

  for (const sub of remotas) {
    const linha = {
      owner_id: account.owner_id,
      reddit_account_id: account.id,
      subreddit_fullname: sub.fullname,
      name: sub.name,
      display_name: sub.displayName,
      url: sub.url,
      over_18: sub.over18,
      submission_type: sub.submissionType,
      link_flair_enabled: sub.linkFlairEnabled,
      can_assign_link_flair: sub.canAssignLinkFlair,
      subreddit_type: sub.subredditType,
      // Reativa quem tinha sumido e voltou.
      status: 'active',
      last_synced_at: agora,
    }

    if (porFullname.has(sub.fullname)) {
      atualizadas++
    } else {
      criadas++
    }

    await admin
      .from('subreddits')
      .upsert(linha, { onConflict: 'reddit_account_id,subreddit_fullname' })
  }

  // O que sumiu da listagem é marcado, nunca apagado: publicações agendadas
  // apontam para essas linhas e o histórico precisa continuar legível.
  const vistos = new Set(remotas.map((s) => s.fullname))
  const sumidas = (existentes ?? []).filter(
    (s) => !vistos.has(s.subreddit_fullname as string) && s.status !== 'removed',
  )

  if (sumidas.length > 0) {
    await admin
      .from('subreddits')
      .update({ status: 'removed', last_synced_at: agora })
      .in(
        'id',
        sumidas.map((s) => s.id as string),
      )
  }

  return {
    criadas,
    atualizadas,
    removidas: sumidas.length,
    total: remotas.length,
  }
}
