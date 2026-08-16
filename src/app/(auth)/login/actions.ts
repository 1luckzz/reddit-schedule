'use server'

import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/lib/supabase/server'
import { credentialsSchema, type AuthState } from './schema'

function parse(formData: FormData) {
  return credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })
}

export async function signIn(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = parse(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  if (error) {
    // Mensagem genérica de propósito: não revela se o email existe.
    return { error: 'Email ou senha inválidos.' }
  }

  redirect('/dashboard')
}

export async function signUp(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = parse(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.signUp(parsed.data)
  if (error) {
    return { error: 'Não foi possível criar a conta. Tente novamente.' }
  }

  redirect('/dashboard')
}
