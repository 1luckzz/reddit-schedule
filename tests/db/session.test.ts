import { afterAll, describe, expect, it } from 'vitest'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { adminClient, cleanupTestUsers } from './helpers'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!

/**
 * Cookie store em memória, no mesmo formato que o @supabase/ssr usa no
 * servidor. Permite exercitar a cadeia real — createServerClient grava a
 * sessão em cookies, getClaims valida o JWT — sem subir um navegador.
 */
function memoryCookieStore() {
  const jar = new Map<string, string>()
  return {
    jar,
    cookies: {
      getAll() {
        return [...jar.entries()].map(([name, value]) => ({ name, value }))
      },
      setAll(
        list: { name: string; value: string; options?: CookieOptions }[],
      ) {
        list.forEach(({ name, value }) => jar.set(name, value))
      },
    },
  }
}

const created: string[] = []

afterAll(async () => {
  await cleanupTestUsers(created)
})

describe('sessão do painel', () => {
  it('signUp cria usuário, sessão em cookie e profile pelo trigger', async () => {
    const store = memoryCookieStore()
    const supabase = createServerClient(URL, PUBLISHABLE, {
      cookies: store.cookies,
    })

    const email = `sess-${Date.now()}@teste.local`
    const { data, error } = await supabase.auth.signUp({
      email,
      password: 'senha-forte-123',
    })
    expect(error).toBeNull()
    created.push(data.user!.id)

    // A sessão foi persistida em cookie, como aconteceria na server action.
    const authCookie = [...store.jar.keys()].find((k) => k.includes('auth-token'))
    expect(authCookie).toBeDefined()

    // E o trigger criou o profile com o timezone padrão da spec.
    const profile = await adminClient()
      .from('profiles')
      .select('timezone')
      .eq('id', data.user!.id)
      .single()
    expect(profile.data!.timezone).toBe('America/Sao_Paulo')
  })

  it('getClaims valida a sessão e devolve o sub do usuário', async () => {
    const store = memoryCookieStore()
    const supabase = createServerClient(URL, PUBLISHABLE, {
      cookies: store.cookies,
    })

    const email = `claims-${Date.now()}@teste.local`
    const signUp = await supabase.auth.signUp({
      email,
      password: 'senha-forte-123',
    })
    created.push(signUp.data.user!.id)

    const { data, error } = await supabase.auth.getClaims()
    expect(error).toBeNull()
    expect(data?.claims.sub).toBe(signUp.data.user!.id)
    expect(data?.claims.email).toBe(email)
  })

  it('sem cookie de sessão, getClaims não devolve usuário', async () => {
    const store = memoryCookieStore()
    const supabase = createServerClient(URL, PUBLISHABLE, {
      cookies: store.cookies,
    })

    const { data } = await supabase.auth.getClaims()
    expect(data?.claims).toBeUndefined()
  })

  it('signOut limpa a sessão', async () => {
    const store = memoryCookieStore()
    const supabase = createServerClient(URL, PUBLISHABLE, {
      cookies: store.cookies,
    })

    const email = `out-${Date.now()}@teste.local`
    const signUp = await supabase.auth.signUp({
      email,
      password: 'senha-forte-123',
    })
    created.push(signUp.data.user!.id)
    expect((await supabase.auth.getClaims()).data?.claims.sub).toBeDefined()

    await supabase.auth.signOut()
    expect((await supabase.auth.getClaims()).data?.claims).toBeUndefined()
  })

  it('credenciais inválidas não criam sessão', async () => {
    const store = memoryCookieStore()
    const supabase = createServerClient(URL, PUBLISHABLE, {
      cookies: store.cookies,
    })

    const { error } = await supabase.auth.signInWithPassword({
      email: 'nao-existe@teste.local',
      password: 'senha-errada-123',
    })
    expect(error).not.toBeNull()
    expect((await supabase.auth.getClaims()).data?.claims).toBeUndefined()
  })
})
