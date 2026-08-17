import { NetworkForm } from './network-form'

const STATUS_LABEL: Record<string, string> = {
  connected: 'Conectada',
  expired: 'Autorização expirada',
  disconnected: 'Desconectada',
  revoked: 'Revogada',
}

// A mesma linguagem de lâmpada do resto do console.
const STATUS_CLASS: Record<string, string> = {
  connected: 'text-ok border-ok/30 bg-ok/10',
  expired: 'text-ambar border-ambar/35 bg-ambar/10',
  disconnected: 'text-tijolo border-tijolo/35 bg-tijolo/10',
  revoked: 'text-tijolo border-tijolo/35 bg-tijolo/10',
}

const STATUS_LAMPADA: Record<string, string> = {
  connected: 'bg-ok',
  expired: 'bg-ambar',
  disconnected: 'bg-tijolo',
  revoked: 'bg-tijolo',
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
    <div className="rounded-md border border-risco bg-console p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium text-fosforo">u/{account.username}</p>
          <p className="mt-0.5 text-xs text-fosforo-dim">
            {account.last_authenticated_at
              ? `Autorizada em ${new Date(
                  account.last_authenticated_at,
                ).toLocaleString('pt-BR')}`
              : 'Nunca autorizada'}
          </p>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-display text-[11px] font-medium uppercase tracking-[0.08em] ${
            STATUS_CLASS[account.status] ?? STATUS_CLASS.disconnected
          }`}
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              STATUS_LAMPADA[account.status] ?? 'bg-tijolo'
            }`}
          />
          {STATUS_LABEL[account.status] ?? account.status}
        </span>
      </div>

      {account.status !== 'connected' && (
        <p className="mt-3 text-sm text-fosforo-dim">
          Esta conta precisa ser reconectada para voltar a publicar.
        </p>
      )}

      <p className="mt-3 font-mono text-[11px] text-fosforo-dim">
        Permissões: {account.scopes.join(', ')}
      </p>

      <div className="mt-3 border-t border-risco pt-3">
        <p className="font-mono text-[11px] text-fosforo-dim">
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
