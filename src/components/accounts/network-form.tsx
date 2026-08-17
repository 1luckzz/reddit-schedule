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
  'mt-1.5 w-full rounded-lg border border-traco bg-fundo px-2.5 py-1.5 text-sm text-claro transition-colors focus:border-traco-forte'

const smallButton =
  'rounded-lg border border-traco px-2.5 py-1 text-xs text-medio transition-colors duration-150 hover:border-traco-forte hover:text-claro active:scale-[0.98] disabled:opacity-50'

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
            className="rounded-lg border border-rosa/30 px-2.5 py-1 text-xs text-rosa transition-colors duration-150 hover:border-rosa/50 hover:bg-rosa/10 active:scale-[0.98] disabled:opacity-50"
          >
            Desconectar conta
          </button>
        </form>
      </div>

      {aberto && (
        <form action={action} className="anima-painel mt-4 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="accountId" value={accountId} />

          <label className="text-[13px] font-medium text-medio">
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

          <label className="text-[13px] font-medium text-medio">
            Host
            <input name="host" required className={field} />
          </label>

          <label className="text-[13px] font-medium text-medio">
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

          <label className="text-[13px] font-medium text-medio">
            Usuário (opcional)
            <input name="username" autoComplete="off" className={field} />
          </label>

          <label className="text-[13px] font-medium text-medio sm:col-span-2">
            Senha (opcional)
            {/* Nasce sempre vazio: a senha nunca volta do servidor. */}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              className={field}
            />
            <span className="mt-1.5 block text-[11px] text-fraco">
              Deixe em branco para manter a senha atual. Para apagá-la, use
              &quot;Remover credenciais&quot;.
            </span>
          </label>

          {state.error && (
            <p role="alert" className="text-xs text-rosa sm:col-span-2">
              {state.error}
            </p>
          )}

          <p className="text-xs text-fraco sm:col-span-2">
            A rota é fixa para esta conta enquanto estiver habilitada. Não há
            rotação nem troca de rota após erro.
          </p>

          <div className="sm:col-span-2">
            <button
              disabled={pending}
              className="rounded-lg bg-forte px-3 py-1.5 text-xs font-medium text-fundo transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
            >
              {pending ? 'Salvando…' : 'Salvar configuração de rede'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
