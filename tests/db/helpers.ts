import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const SECRET = process.env.SUPABASE_SECRET_KEY!

/** Client com a chave secreta: ignora RLS. Só para arranjo e conferência. */
export function adminClient(): SupabaseClient {
  return createClient(URL, SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function createTestUser(email: string) {
  const admin = adminClient()
  const password = 'senha-de-teste-123456'
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw error

  const anon = createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false },
  })
  const signIn = await anon.auth.signInWithPassword({ email, password })
  if (signIn.error) throw signIn.error

  return {
    id: data.user!.id,
    accessToken: signIn.data.session!.access_token,
  }
}

/** Client que enxerga o banco exatamente como aquele usuário, com RLS ativa. */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

export async function cleanupTestUsers(ids: string[]) {
  const admin = adminClient()
  for (const id of ids) {
    await admin.auth.admin.deleteUser(id)
  }
}
