import { createBrowserClient } from '@supabase/ssr'

/**
 * Client para Client Components. Já usa singleton internamente, então pode
 * ser chamado quantas vezes for preciso.
 */
export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}
