import type { SupabaseClient } from '@supabase/supabase-js'
import { makeServiceClient } from '../src/lib/supabase/service-factory'

/**
 * Client do worker. Mesma factory do Next, ambiente lido aqui.
 *
 * Este arquivo mora em `worker/` e não em `src/` de propósito: nada dentro do
 * Next o importa, então a leitura da chave fica fora do alcance de qualquer
 * bundle de cliente sem depender da marca `server-only` — que, aliás, não
 * poderia ser usada aqui, porque o pacote lança fora do ambiente de servidor
 * React.
 *
 * O worker é um processo longo: um único client basta para todo o ciclo.
 */
let cache: SupabaseClient | null = null

export function workerServiceClient(): SupabaseClient {
  if (cache) return cache
  cache = makeServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SECRET_KEY ?? '',
  )
  return cache
}
