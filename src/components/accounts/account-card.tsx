import { NetworkForm } from './network-form'

const STATUS_LABEL: Record<string, string> = {
  connected: 'Conectada',
  expired: 'Autorização expirada',
  disconnected: 'Desconectada',
  revoked: 'Revogada',
}

// O mesmo código de estado discreto dos chips do painel: chip cinza,
// estado indicado só pelo ponto dessaturado.
const STATUS_PONTO: Record<string, string> = {
  connected: 'bg-salvia',
  expired: 'bg-areia',
  disconnected: 'bg-rosa',
  revoked: 'bg-rosa',
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
    <div className="rounded-xl border border-traco bg-superficie p-5 shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-colors duration-150 hover:border-traco-forte">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium text-forte">u/{account.username}</p>
          <p className="mt-0.5 text-xs text-medio">
            {account.last_authenticated_at
              ? `Autorizada em ${new Date(
                  account.last_authenticated_at,
                ).toLocaleString('pt-BR')}`
              : 'Nunca autorizada'}
          </p>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-md border border-traco bg-white/5 px-2 py-0.5 text-xs text-medio">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              STATUS_PONTO[account.status] ?? 'bg-rosa'
            }`}
          />
          {STATUS_LABEL[account.status] ?? account.status}
        </span>
      </div>

      {account.status !== 'connected' && (
        <p className="mt-3 text-sm text-medio">
          Esta conta precisa ser reconectada para voltar a publicar.
        </p>
      )}

      <p className="mt-3 text-xs text-fraco">
        Permissões: {account.scopes.join(', ')}
      </p>

      <div className="mt-4 border-t border-white/5 pt-3.5">
        <p className="text-xs text-fraco">
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
