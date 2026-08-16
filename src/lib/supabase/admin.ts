import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { getCoreEnv } from '@/lib/config/env'

/**
 * Client com a chave secreta: IGNORA RLS por completo.
 *
 * Nunca chame isto com um id vindo do cliente sem antes confirmar a posse do
 * recurso. A partir do Plano 2, o acesso a segredos passa obrigatoriamente
 * pelos helpers de src/lib/auth/ownership.ts, que só entregam recursos já
 * verificados.
 */
export function createAdminSupabase() {
  const env = getCoreEnv()
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
