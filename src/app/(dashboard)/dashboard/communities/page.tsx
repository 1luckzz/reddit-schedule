import { createServerSupabase } from '@/lib/supabase/server'
import {
  CommunityList,
  type CommunityRow,
} from '@/components/communities/community-list'
import { SyncButton } from '@/components/communities/sync-button'

export default async function CommunitiesPage() {
  const supabase = await createServerSupabase()

  const { data: contas } = await supabase
    .from('reddit_accounts')
    .select('id, username, status')
    .order('username')

  // Removidas ficam fora da lista: o histórico continua no banco, mas não faz
  // sentido oferecê-las para novas publicações.
  const { data: comunidades } = await supabase
    .from('subreddits')
    .select(
      'id, name, display_name, url, over_18, submission_type, link_flair_enabled, last_synced_at, reddit_account_id',
    )
    .eq('status', 'active')
    .order('name')

  const porConta = new Map<string, CommunityRow[]>()
  for (const c of comunidades ?? []) {
    const chave = c.reddit_account_id as string
    porConta.set(chave, [...(porConta.get(chave) ?? []), c as CommunityRow])
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Comunidades
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Comunidades que cada conta modera, lidas da API oficial do Reddit.
      </p>

      {(contas ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Conecte uma conta Reddit para sincronizar comunidades.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {contas!.map((conta) => {
            const lista = porConta.get(conta.id) ?? []
            const ultima = lista.find((c) => c.last_synced_at)?.last_synced_at

            return (
              <section
                key={conta.id}
                className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium text-neutral-900 dark:text-neutral-50">
                      u/{conta.username}
                    </h2>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {ultima
                        ? `Sincronizada em ${new Date(ultima).toLocaleString('pt-BR')}`
                        : 'Nunca sincronizada'}
                      {' · '}
                      {lista.length} comunidade(s)
                    </p>
                  </div>

                  {conta.status === 'connected' ? (
                    <SyncButton accountId={conta.id} username={conta.username} />
                  ) : (
                    <p className="text-xs text-red-600">
                      Reconecte a conta para sincronizar.
                    </p>
                  )}
                </div>

                <CommunityList communities={lista} />
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
