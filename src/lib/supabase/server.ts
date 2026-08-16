import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getCoreEnv } from '@/lib/config/env'

/**
 * Client para Server Components, Server Actions e Route Handlers.
 * Respeita RLS: enxerga o banco como o usuário da sessão.
 *
 * Precisa ser recriado a cada request, porque depende dos cookies daquele
 * request.
 */
export async function createServerSupabase() {
  const env = getCoreEnv()
  const cookieStore = await cookies()

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Chamado de um Server Component, onde não se pode escrever
            // cookies. Ignorável: o proxy renova a sessão a cada request.
          }
        },
      },
    },
  )
}
