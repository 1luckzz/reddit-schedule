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
          className="rounded-sm border border-ambar/50 px-2.5 py-1.5 font-display text-xs font-medium uppercase tracking-[0.08em] text-ambar transition-colors hover:bg-ambar/15 disabled:opacity-50"
        >
          {pending ? 'Sincronizando…' : `Sincronizar u/${username}`}
        </button>
      </form>

      {state.error && (
        <p role="alert" className="mt-2 text-xs text-tijolo">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="mt-2 text-xs text-ok">
          {state.message}
        </p>
      )}
    </div>
  )
}
