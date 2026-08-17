import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Cria um client com a chave secreta: IGNORA RLS por completo.
 *
 * Esta função é deliberadamente PURA — recebe URL e chave como argumentos e
 * nunca toca em `process.env`. É o que permite compartilhá-la entre o Next e o
 * worker sem que ela vire um caminho até o segredo: o módulo em si não tem
 * nada a vazar.
 *
 * Quem lê o ambiente são os invólucros, cada um do seu lado da fronteira:
 *   - `src/lib/supabase/admin.ts`, marcado `server-only`, para o Next;
 *   - `worker/supabase.ts`, fora da árvore de módulos do Next, para o worker.
 *
 * Não chame esta função diretamente de código de aplicação. Use um invólucro.
 */
export function makeServiceClient(
  url: string,
  secretKey: string,
): SupabaseClient {
  // Falhar aqui é bem melhor que criar um client mudo que erra 401 depois, em
  // algum ponto distante de onde a configuração está errada.
  if (!url) throw new Error('URL do Supabase ausente ao criar service client.')
  if (!secretKey) {
    throw new Error('Chave secreta ausente ao criar service client.')
  }

  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
