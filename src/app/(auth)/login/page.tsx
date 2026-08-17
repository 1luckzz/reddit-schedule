'use client'

import { useActionState } from 'react'
import { signIn, signUp } from './actions'
import type { AuthState } from './schema'

const initial: AuthState = { error: null }

const inputClass =
  'mt-1 w-full rounded-sm border border-risco bg-estudio px-3 py-2 text-sm text-fosforo transition-colors focus:border-ambar'

const labelClass =
  'block font-display text-[11px] font-medium uppercase tracking-[0.12em] text-fosforo-dim'

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, initial)
  const [signUpState, signUpAction, signUpPending] = useActionState(
    signUp,
    initial,
  )
  const error = state.error ?? signUpState.error
  const busy = pending || signUpPending

  return (
    <main className="flex min-h-screen items-center justify-center bg-estudio p-6">
      <div className="w-full max-w-sm rounded-md border border-risco bg-console p-8">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full bg-ambar" />
          <h1 className="font-display text-lg font-semibold uppercase tracking-[0.16em] text-fosforo">
            Reddit Scheduler
          </h1>
        </div>
        <p className="mt-1 text-sm text-fosforo-dim">
          Entre para acessar o painel.
        </p>

        <form className="mt-6 space-y-4">
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
            <p role="alert" className="text-sm text-tijolo">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              formAction={action}
              disabled={busy}
              className="flex-1 rounded-sm bg-ambar px-3 py-2 font-display text-sm font-semibold uppercase tracking-[0.08em] text-estudio transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Entrando…' : 'Entrar'}
            </button>
            <button
              formAction={signUpAction}
              disabled={busy}
              className="rounded-sm border border-risco px-3 py-2 text-sm text-fosforo-dim transition-colors hover:bg-console-2 hover:text-fosforo disabled:opacity-50"
            >
              {signUpPending ? 'Criando…' : 'Criar conta'}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
