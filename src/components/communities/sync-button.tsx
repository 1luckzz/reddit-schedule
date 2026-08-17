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
          className="rounded-lg border border-traco px-3 py-1.5 text-[13px] text-medio transition-colors duration-150 hover:border-traco-forte hover:text-claro active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? 'Sincronizando…' : `Sincronizar u/${username}`}
        </button>
      </form>

      {state.error && (
        <p role="alert" className="mt-2 text-xs text-rosa">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="mt-2 text-xs text-salvia">
          {state.message}
        </p>
      )}
    </div>
  )
}
