import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import {
  getBudgetWith,
  reconcileBudgetWith,
  reserveBudgetWith,
} from './budget-core'
import type { RateLimitSnapshot } from './types'

// A lógica mora em `budget-core.ts`, sem `server-only`, para que o worker use
// exatamente o mesmo controle. Aqui ficam só os invólucros do Next, que
// injetam o client administrativo.
export { BUDGET_THRESHOLD } from './budget-core'
export type { Budget } from './budget-core'

export async function reserveBudget(): Promise<void> {
  return reserveBudgetWith(createAdminSupabase())
}

export async function reconcileBudget(
  snapshot: RateLimitSnapshot | null,
): Promise<void> {
  return reconcileBudgetWith(createAdminSupabase(), snapshot)
}

export async function getBudget() {
  return getBudgetWith(createAdminSupabase())
}
