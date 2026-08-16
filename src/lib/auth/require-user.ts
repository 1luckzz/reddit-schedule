import 'server-only'
import { createServerSupabase } from '@/lib/supabase/server'

export class UnauthenticatedError extends Error {
  constructor() {
    super('Sessão ausente ou inválida.')
    this.name = 'UnauthenticatedError'
  }
}

/**
 * Fonte única de identidade no servidor.
 *
 * Usa getClaims(), que valida a assinatura do JWT contra as chaves públicas
 * do projeto. getSession() não revalida o token e por isso nunca é usado em
 * código de servidor.
 */
export async function requireUser(): Promise<{ id: string; email: string }> {
  const supabase = await createServerSupabase()
  const { data, error } = await supabase.auth.getClaims()
  const claims = data?.claims
  if (error || !claims?.sub) throw new UnauthenticatedError()
  return { id: claims.sub as string, email: (claims.email as string) ?? '' }
}
