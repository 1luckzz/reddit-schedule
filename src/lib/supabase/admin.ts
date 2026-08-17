import 'server-only'
import { getCoreEnv } from '@/lib/config/env'
import { makeServiceClient } from './service-factory'

/**
 * Client com a chave secreta para uso dentro do Next: IGNORA RLS.
 *
 * A marca `server-only` acima é o que impede este módulo — e portanto a
 * leitura da chave — de entrar em um bundle de cliente.
 *
 * Nunca chame isto com um id vindo do cliente sem antes confirmar a posse do
 * recurso. A partir do Plano 2, o acesso a segredos passa obrigatoriamente
 * pelos helpers de src/lib/auth/ownership.ts, que só entregam recursos já
 * verificados.
 */
export function createAdminSupabase() {
  const env = getCoreEnv()
  return makeServiceClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
  )
}
