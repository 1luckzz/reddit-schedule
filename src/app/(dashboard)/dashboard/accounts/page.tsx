import Link from 'next/link'
import { createServerSupabase } from '@/lib/supabase/server'
import { AccountCard, type NetworkRow } from '@/components/accounts/account-card'

const MENSAGENS: Record<string, string> = {
  state_invalido:
    'A solicitação expirou ou já foi usada. Tente conectar a conta novamente.',
  autorizacao_recusada: 'A autorização foi recusada no Reddit.',
  conta_em_uso: 'Esta conta Reddit já está conectada em outro usuário do painel.',
  falha_ao_conectar:
    'Não foi possível concluir a conexão com o Reddit. Tente novamente.',
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>
}) {
  const { erro } = await searchParams
  const supabase = await createServerSupabase()

  const { data: contas } = await supabase
    .from('reddit_accounts')
    .select('id, username, status, scopes, last_authenticated_at, last_error')
    .order('username')

  // Host sempre mascarado: vem da view, nunca da tabela de configuração.
  const { data: rede } = await supabase
    .from('reddit_account_network_status')
    .select(
      'reddit_account_id, proxy_enabled, proxy_protocol, proxy_host_masked, proxy_port',
    )

  const redePorConta = new Map<string, NetworkRow>(
    (rede ?? []).map((r) => [r.reddit_account_id as string, r as NetworkRow]),
  )

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
            Contas Reddit
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Conecte suas contas via OAuth oficial do Reddit.
          </p>
        </div>
        <Link
          href="/api/reddit/authorize"
          prefetch={false}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Conectar conta
        </Link>
      </div>

      {erro && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {MENSAGENS[erro] ?? 'Não foi possível concluir a operação.'}
        </p>
      )}

      {(contas ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Nenhuma conta conectada ainda.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {contas!.map((conta) => (
            <li key={conta.id}>
              <AccountCard
                account={conta}
                network={redePorConta.get(conta.id) ?? null}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
