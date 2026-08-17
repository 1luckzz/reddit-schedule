'use client'

import { useActionState, useState } from 'react'
import {
  clearProxyCredentials,
  disableNetworkConfig,
  disconnectAccount,
  saveNetworkConfig,
} from '@/app/(dashboard)/dashboard/accounts/actions'
import type { ActionState } from '@/app/(dashboard)/dashboard/accounts/schema'
import {
  isExperimentalProtocol,
  SUPPORTED_PROXY_PROTOCOLS,
} from '@/lib/reddit/proxy-support'

const initial: ActionState = { error: null, ok: false }

const field =
  'mt-1 w-full rounded-sm border border-risco bg-estudio px-2 py-1.5 text-sm text-fosforo transition-colors focus:border-ambar'

const smallButton =
  'rounded-sm border border-risco px-2 py-1 text-xs text-fosforo-dim transition-colors hover:bg-console-2 hover:text-fosforo disabled:opacity-50'

export function NetworkForm({
  accountId,
  enabled,
}: {
  accountId: string
  enabled: boolean
}) {
  const [aberto, setAberto] = useState(false)
  const [state, action, pending] = useActionState(saveNetworkConfig, initial)
  const [, disableAction, disabling] = useActionState(
    disableNetworkConfig,
    initial,
  )
  const [, clearCredsAction, clearingCreds] = useActionState(
    clearProxyCredentials,
    initial,
  )
  const [, disconnectAction, disconnecting] = useActionState(
    disconnectAccount,
    initial,
  )

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          className={smallButton}
        >
          {aberto ? 'Fechar' : 'Configurar rede'}
        </button>

        {enabled && (
          <>
            <form action={clearCredsAction}>
              <input type="hidden" name="accountId" value={accountId} />
              <button
                disabled={clearingCreds}
                title="Remove usuário e senha, mantendo host e porta"
                className={smallButton}
              >
                Remover credenciais
              </button>
            </form>

            <form action={disableAction}>
              <input type="hidden" name="accountId" value={accountId} />
              <button disabled={disabling} className={smallButton}>
                Usar conexão direta
              </button>
            </form>
          </>
        )}

        <form action={disconnectAction}>
          <input type="hidden" name="accountId" value={accountId} />
          <button
            disabled={disconnecting}
            className="rounded-sm border border-tijolo/50 px-2 py-1 text-xs text-tijolo transition-colors hover:bg-tijolo/10 disabled:opacity-50"
          >
            Desconectar conta
          </button>
        </form>
      </div>

      {aberto && (
        <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="accountId" value={accountId} />

          <label className="text-xs text-fosforo-dim">
            Protocolo
            <select name="protocol" className={field} defaultValue="http">
              {SUPPORTED_PROXY_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                  {isExperimentalProtocol(p) ? ' (experimental)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs text-fosforo-dim">
            Host
            <input name="host" required className={field} />
          </label>

          <label className="text-xs text-fosforo-dim">
            Porta
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              required
              className={field}
            />
          </label>

          <label className="text-xs text-fosforo-dim">
            Usuário (opcional)
            <input name="username" autoComplete="off" className={field} />
          </label>

          <label className="text-xs text-fosforo-dim sm:col-span-2">
            Senha (opcional)
            {/* Nasce sempre vazio: a senha nunca volta do servidor. */}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              className={field}
            />
            <span className="mt-1 block text-[11px] text-fosforo-dim/80">
              Deixe em branco para manter a senha atual. Para apagá-la, use
              &quot;Remover credenciais&quot;.
            </span>
          </label>

          {state.error && (
            <p role="alert" className="text-xs text-tijolo sm:col-span-2">
              {state.error}
            </p>
          )}

          <p className="text-[11px] text-fosforo-dim/80 sm:col-span-2">
            A rota é fixa para esta conta enquanto estiver habilitada. Não há
            rotação nem troca de rota após erro.
          </p>

          <div className="sm:col-span-2">
            <button
              disabled={pending}
              className="rounded-sm bg-ambar px-3 py-1.5 font-display text-xs font-semibold uppercase tracking-[0.08em] text-estudio transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Salvando…' : 'Salvar configuração de rede'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
