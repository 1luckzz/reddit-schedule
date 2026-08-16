import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { getCoreEnv } from '@/lib/config/env'

export async function POST() {
  const supabase = await createServerSupabase()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', getCoreEnv().APP_URL), {
    status: 303,
  })
}
