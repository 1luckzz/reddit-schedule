import { NextResponse } from 'next/server'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'
import { buildAuthorizeUrl, createOAuthState } from '@/lib/reddit/auth'
import { getCoreEnv } from '@/lib/config/env'

// ProxyAgent e node:crypto exigem o runtime Node.
export const runtime = 'nodejs'

export async function GET() {
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

  const { value, cookie } = await createOAuthState(user.id)
  const response = NextResponse.redirect(buildAuthorizeUrl(value))
  response.cookies.set(cookie.name, cookie.value, {
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    path: cookie.path,
    maxAge: cookie.maxAge,
  })
  return response
}
