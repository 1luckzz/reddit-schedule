import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'

// No Next 16 a convenção `middleware` foi renomeada para `proxy`.
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
