'use client'

import { useActionState } from 'react'
import {
  syncCommunities,
  type SyncState,
} from '@/app/(dashboard)/dashboard/communities/actions'

const initial: SyncState = { error: null, message: null }

export function SyncButton({
  accountId,
  username,
}: {
  accountId: string
  username: string
}) {
  const [state, action, pending] = useActionState(syncCommunities, initial)

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="accountId" value={accountId} />
        <button
          disabled={pending}
          className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
        >
          {pending ? 'Sincronizando…' : `Sincronizar u/${username}`}
        </button>
      </form>

      {state.error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="mt-2 text-xs text-green-700 dark:text-green-400">
          {state.message}
        </p>
      )}
    </div>
  )
}
