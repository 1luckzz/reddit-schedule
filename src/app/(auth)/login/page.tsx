'use client'

import { useActionState } from 'react'
import { signIn, signUp } from './actions'
import type { AuthState } from './schema'

const initial: AuthState = { error: null }

const inputClass =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none transition-colors focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100'

const labelClass =
  'block text-sm font-medium text-neutral-700 dark:text-neutral-300'

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, initial)
  const [signUpState, signUpAction, signUpPending] = useActionState(
    signUp,
    initial,
  )
  const error = state.error ?? signUpState.error
  const busy = pending || signUpPending

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
          Reddit Scheduler
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
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
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              formAction={action}
              disabled={busy}
              className="flex-1 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {pending ? 'Entrando…' : 'Entrar'}
            </button>
            <button
              formAction={signUpAction}
              disabled={busy}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {signUpPending ? 'Criando…' : 'Criar conta'}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
