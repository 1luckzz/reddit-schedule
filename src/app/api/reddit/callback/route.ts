import { NextResponse, type NextRequest } from 'next/server'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'
import {
  consumeOAuthState,
  exchangeCode,
  fetchIdentity,
  STATE_COOKIE,
} from '@/lib/reddit/auth'
import { AccountTakenError, connectAccount } from '@/lib/reddit/connect-account'
import { getCoreEnv } from '@/lib/config/env'
import { sanitize } from '@/lib/logging/sanitize'

export const runtime = 'nodejs'

function back(base: string, erro?: string) {
  const url = new URL('/dashboard/accounts', base)
  if (erro) url.searchParams.set('erro', erro)
  const response = NextResponse.redirect(url)
  // O cookie de state é descartado em qualquer desfecho.
  response.cookies.delete(STATE_COOKIE)
  return response
}

export async function GET(request: NextRequest) {
  const base = getCoreEnv().APP_URL

  let user
  try {
    user = await requireUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL('/login', base))
    }
    throw e
  }

  const params = request.nextUrl.searchParams

  // O usuário pode simplesmente ter recusado no Reddit.
  if (params.get('error')) {
    return back(base, 'autorizacao_recusada')
  }

  const code = params.get('code')
  const state = params.get('state')
  const cookie = request.cookies.get(STATE_COOKIE)?.value

  if (!code || !state || !cookie || cookie !== state) {
    return back(base, 'state_invalido')
  }

  try {
    // Consome antes de qualquer chamada externa: uso único, vinculado à sessão.
    await consumeOAuthState(state, user.id)
    const token = await exchangeCode(code)
    const identity = await fetchIdentity(token.access_token)
    await connectAccount(user.id, token, identity)
    return back(base)
  } catch (e) {
    if (e instanceof AccountTakenError) {
      return back(base, 'conta_em_uso')
    }
    console.error('reddit/callback', sanitize(e))
    return back(base, 'falha_ao_conectar')
  }
}
