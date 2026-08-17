import { createServerSupabase } from '@/lib/supabase/server'
import {
  CommunityList,
  type CommunityRow,
} from '@/components/communities/community-list'
import { SyncButton } from '@/components/communities/sync-button'
import {
  descricaoPagina,
  estadoVazio,
  modulo,
  tituloPagina,
} from '@/components/ui/estilo'

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
    <div className="anima-entrada">
      <h1 className={tituloPagina}>Comunidades</h1>
      <p className={descricaoPagina}>
        Comunidades que cada conta modera, lidas da API oficial do Reddit.
      </p>

      {(contas ?? []).length === 0 ? (
        <div className={`${estadoVazio} mt-6`}>
          Conecte uma conta Reddit para sincronizar comunidades.
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {contas!.map((conta) => {
            const lista = porConta.get(conta.id) ?? []
            const ultima = lista.find((c) => c.last_synced_at)?.last_synced_at

            return (
              <section
                key={conta.id}
                className={`${modulo} p-5`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium text-forte">
                      u/{conta.username}
                    </h2>
                    <p className="mt-0.5 text-xs text-medio">
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
                    <p className="text-xs text-rosa">
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
