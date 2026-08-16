import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/login', '/auth', '/api/health']

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  // Com Fluid compute, nunca guarde este client num global: crie um por request.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
          // Headers de cache que impedem CDNs de servir a sessão de um
          // usuário para outro.
          Object.entries(headers).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value),
          )
        },
      },
    },
  )

  // Não coloque código entre createServerClient e getClaims(): um erro aqui
  // provoca logout aleatório de usuários e é dificílimo de depurar.
  // getClaims valida a assinatura do JWT contra as chaves públicas do projeto,
  // ao contrário de getSession, que não revalida nada.
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims

  const isPublic = PUBLIC_PATHS.some((p) =>
    request.nextUrl.pathname.startsWith(p),
  )

  if (!claims && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // O objeto supabaseResponse precisa ser devolvido como está, sob pena de
  // dessincronizar os cookies entre navegador e servidor.
  return supabaseResponse
}
