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
  'mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100'

const smallButton =
  'rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300'

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
            className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-400"
          >
            Desconectar conta
          </button>
        </form>
      </div>

      {aberto && (
        <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="accountId" value={accountId} />

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
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

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
            Host
            <input name="host" required className={field} />
          </label>

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
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

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
            Usuário (opcional)
            <input name="username" autoComplete="off" className={field} />
          </label>

          <label className="text-xs text-neutral-600 dark:text-neutral-400 sm:col-span-2">
            Senha (opcional)
            {/* Nasce sempre vazio: a senha nunca volta do servidor. */}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              className={field}
            />
            <span className="mt-1 block text-[11px] text-neutral-500">
              Deixe em branco para manter a senha atual. Para apagá-la, use
              &quot;Remover credenciais&quot;.
            </span>
          </label>

          {state.error && (
            <p role="alert" className="text-xs text-red-600 sm:col-span-2">
              {state.error}
            </p>
          )}

          <p className="text-[11px] text-neutral-500 sm:col-span-2">
            A rota é fixa para esta conta enquanto estiver habilitada. Não há
            rotação nem troca de rota após erro.
          </p>

          <div className="sm:col-span-2">
            <button
              disabled={pending}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {pending ? 'Salvando…' : 'Salvar configuração de rede'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
