// src/app/api/reddit/flairs/route.ts
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'
import { assertAccountAccess, ForbiddenError } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { listLinkFlairs } from '@/lib/reddit/flairs'
import { RedditError } from '@/lib/reddit/errors'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    await requireUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ erro: 'Sessão ausente.' }, { status: 401 })
    }
    throw e
  }

  const accountId = request.nextUrl.searchParams.get('accountId')
  const subredditId = request.nextUrl.searchParams.get('subredditId')
  if (!accountId || !subredditId) {
    return NextResponse.json({ erro: 'Parâmetros ausentes.' }, { status: 400 })
  }

  try {
    const account = await assertAccountAccess(accountId)

    const supabase = await createServerSupabase()
    const { data: subreddit } = await supabase
      .from('subreddits')
      .select('name, reddit_account_id')
      .eq('id', subredditId)
      .maybeSingle()

    if (!subreddit || subreddit.reddit_account_id !== account.id) {
      return NextResponse.json(
        { erro: 'Comunidade não encontrada para esta conta.' },
        { status: 404 },
      )
    }

    const client = await getRedditClient(account)
    const flairs = await listLinkFlairs(client, subreddit.name)

    // Lista vazia aqui significa mesmo "não há flair cadastrado": qualquer
    // falha de leitura teria lançado.
    return NextResponse.json({ flairs })
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ erro: 'Conta não encontrada.' }, { status: 404 })
    }
    if (e instanceof RedditError) {
      const indisponivel = e.code === 'FLAIRS_UNAVAILABLE'
      return NextResponse.json(
        { erro: e.userMessage, indisponivel },
        { status: indisponivel ? 409 : 502 },
      )
    }
    return NextResponse.json(
      { erro: 'Não foi possível carregar os flairs.' },
      { status: 500 },
    )
  }
}
