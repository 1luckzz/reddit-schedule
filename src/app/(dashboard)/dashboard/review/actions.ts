'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { assertAccountAccess } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { findCandidates, type Candidate } from '@/lib/reddit/reconcile'
import { RedditError } from '@/lib/reddit/errors'

export type ReviewState = {
  error: string | null
  candidates: Candidate[] | null
  /** Qual publicação a consulta respondeu, para a interface não trocar. */
  postId: string | null
  ok: boolean
}

const vazio = { candidates: null, postId: null, ok: false }

/**
 * Consulta o Reddit em busca da publicação. Só lê — a decisão é da pessoa.
 *
 * Nunca reenvia, nunca marca nada, e nunca escolhe entre candidatos. Devolver
 * a lista crua é intencional: quando há mais de um compatível, a ambiguidade
 * é a informação mais importante da tela.
 */
export async function checkOnReddit(
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const parsed = z
    .object({ postId: z.uuid() })
    .safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { ...vazio, error: 'Publicação inválida.' }

  try {
    const user = await requireUser()
    const supabase = await createServerSupabase()

    // Lido com o client do usuário: a RLS já restringe, e a conferência
    // explícita de owner_id abaixo é a segunda barreira.
    const { data: post } = await supabase
      .from('scheduled_posts')
      .select(
        'id, owner_id, title, status, reddit_account_id, subreddit_id, submit_attempted_at',
      )
      .eq('id', parsed.data.postId)
      .maybeSingle()

    if (!post || post.owner_id !== user.id) {
      return { ...vazio, error: 'Publicação não encontrada.' }
    }
    if (post.status !== 'needs_review') {
      return { ...vazio, error: 'Esta publicação não está em revisão.' }
    }

    const { data: subreddit } = await supabase
      .from('subreddits')
      .select('name')
      .eq('id', post.subreddit_id)
      .single()

    if (!subreddit) {
      return { ...vazio, error: 'Comunidade não encontrada.' }
    }

    const account = await assertAccountAccess(post.reddit_account_id)
    const client = await getRedditClient(account)

    const candidates = await findCandidates(client, {
      username: account.username,
      subredditName: subreddit.name as string,
      title: post.title,
      attemptedAt: post.submit_attempted_at
        ? new Date(post.submit_attempted_at)
        : new Date(),
    })

    return { error: null, candidates, postId: post.id, ok: true }
  } catch (e) {
    // Indisponibilidade não pode virar "não encontrei nada": as duas levariam
    // a decisões opostas.
    if (e instanceof RedditError) return { ...vazio, error: e.userMessage }
    return { ...vazio, error: 'Não foi possível consultar o Reddit agora.' }
  }
}

const resolveSchema = z.object({
  postId: z.uuid(),
  decision: z.enum(['published', 'failed', 'cancelled']),
  redditPostId: z.string().trim().optional(),
  redditFullname: z.string().trim().optional(),
  permalink: z.string().trim().optional(),
})

/**
 * Registra a decisão da pessoa sobre um job em revisão.
 *
 * O owner vem de `requireUser()`, nunca do formulário — mesma regra do Plano
 * 4. A RPC revalida a posse no próprio predicado, porque `service_role`
 * ignora RLS.
 */
export async function resolveReview(
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const parsed = resolveSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { ...vazio, error: parsed.error.issues[0].message }
  }

  if (
    parsed.data.decision === 'published' &&
    (!parsed.data.redditPostId || !parsed.data.redditFullname)
  ) {
    return {
      ...vazio,
      error: 'Escolha a publicação encontrada no Reddit antes de confirmar.',
    }
  }

  try {
    const user = await requireUser()
    const admin = createAdminSupabase()

    const { error } = await admin.rpc('resolve_needs_review', {
      p_owner_id: user.id,
      p_post_id: parsed.data.postId,
      p_decision: parsed.data.decision,
      p_reddit_post_id: parsed.data.redditPostId || null,
      p_reddit_fullname: parsed.data.redditFullname || null,
      p_permalink: parsed.data.permalink || null,
    })
    if (error) throw error
  } catch {
    return { ...vazio, error: 'Não foi possível registrar a decisão agora.' }
  }

  revalidatePath('/dashboard/review')
  revalidatePath('/dashboard/history')
  revalidatePath('/dashboard')
  return { error: null, candidates: null, postId: null, ok: true }
}
