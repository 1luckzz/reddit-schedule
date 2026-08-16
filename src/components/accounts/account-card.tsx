import { NetworkForm } from './network-form'

const STATUS_LABEL: Record<string, string> = {
  connected: 'Conectada',
  expired: 'Autorização expirada',
  disconnected: 'Desconectada',
  revoked: 'Revogada',
}

const STATUS_CLASS: Record<string, string> = {
  connected: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  expired: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  disconnected: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  revoked: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
}

export type AccountRow = {
  id: string
  username: string
  status: string
  scopes: string[]
  last_authenticated_at: string | null
  last_error: string | null
}

export type NetworkRow = {
  proxy_enabled: boolean
  proxy_protocol: string | null
  proxy_host_masked: string | null
  proxy_port: number | null
}

export function AccountCard({
  account,
  network,
}: {
  account: AccountRow
  network: NetworkRow | null
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium text-neutral-900 dark:text-neutral-50">
            u/{account.username}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {account.last_authenticated_at
              ? `Autorizada em ${new Date(
                  account.last_authenticated_at,
                ).toLocaleString('pt-BR')}`
              : 'Nunca autorizada'}
          </p>
        </div>

        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            STATUS_CLASS[account.status] ?? STATUS_CLASS.disconnected
          }`}
        >
          {STATUS_LABEL[account.status] ?? account.status}
        </span>
      </div>

      {account.status !== 'connected' && (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          Esta conta precisa ser reconectada para voltar a publicar.
        </p>
      )}

      <p className="mt-3 text-xs text-neutral-500">
        Permissões: {account.scopes.join(', ')}
      </p>

      <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <p className="text-xs text-neutral-500">
          {network?.proxy_enabled
            ? `Rede: ${network.proxy_protocol}://${network.proxy_host_masked}:${network.proxy_port}`
            : 'Rede: conexão direta'}
        </p>
        <NetworkForm
          accountId={account.id}
          enabled={network?.proxy_enabled ?? false}
        />
      </div>
    </div>
  )
}
