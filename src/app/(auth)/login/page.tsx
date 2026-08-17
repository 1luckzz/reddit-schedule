'use client'

import { useActionState } from 'react'
import { signIn, signUp } from './actions'
import type { AuthState } from './schema'

const initial: AuthState = { error: null }

const inputClass =
  'mt-1.5 h-9 w-full rounded-lg border border-traco bg-superficie px-3 text-sm text-claro transition-colors placeholder:text-fraco focus:border-traco-forte'

const labelClass = 'block text-[13px] font-medium text-medio'

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, initial)
  const [signUpState, signUpAction, signUpPending] = useActionState(
    signUp,
    initial,
  )
  const error = state.error ?? signUpState.error
  const busy = pending || signUpPending

  return (
    <main className="flex min-h-screen items-center justify-center bg-fundo p-6">
      {/* Sem card: coluna estreita direto sobre o fundo. */}
      <div className="anima-entrada w-full max-w-xs">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-forte">
          Reddit Scheduler
        </h1>
        <p className="mt-1 text-sm text-medio">Entre para acessar o painel.</p>

        <form className="mt-8 space-y-4">
          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="password" className={labelClass}>
              Senha
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={inputClass}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-rosa">
              {error}
            </p>
          )}

          <div className="space-y-2 pt-2">
            <button
              formAction={action}
              disabled={busy}
              className="w-full rounded-lg bg-forte px-3 py-2 text-sm font-medium text-fundo transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
            >
              {pending ? 'Entrando…' : 'Entrar'}
            </button>
            <button
              formAction={signUpAction}
              disabled={busy}
              className="w-full rounded-lg border border-traco px-3 py-2 text-sm text-medio transition-colors duration-150 hover:border-traco-forte hover:text-claro active:scale-[0.98] disabled:opacity-50"
            >
              {signUpPending ? 'Criando…' : 'Criar conta'}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
