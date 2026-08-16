import 'server-only'
import { requireUser } from '@/lib/auth/require-user'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { toUtc } from './timezone'

/** Estados em que o usuário ainda manda no agendamento. */
export const EDITABLE_STATUSES = ['draft', 'scheduled'] as const

export class NotEditableError extends Error {
  constructor(status: string) {
    const rotulos: Record<string, string> = {
      processing: 'está sendo publicada agora',
      published: 'já foi publicada',
      failed: 'falhou e precisa ser reagendada pelo histórico',
      cancelled: 'foi cancelada',
      needs_review: 'aguarda revisão manual',
    }
    super(
      `Não é possível alterar esta publicação: ela ${
        rotulos[status] ?? 'não está mais editável'
      }.`,
    )
    this.name = 'NotEditableError'
  }
}

export class PostNotFoundError extends Error {
  constructor() {
    super('Publicação não encontrada.')
    this.name = 'PostNotFoundError'
  }
}

/**
 * Confere antes de chamar a RPC — não porque a RPC precise, mas porque a
 * mensagem daqui é muito melhor que um erro de função. A autoridade continua
 * sendo a função SQL, que revalida posse e estado sob lock.
 *
 * Devolve o usuário da sessão: é dele que sai o owner passado à RPC.
 */
async function carregarEditavel(postId: string) {
  const user = await requireUser()
  const supabase = await createServerSupabase()

  const { data } = await supabase
    .from('scheduled_posts')
    .select('id, owner_id, status')
    .eq('id', postId)
    .maybeSingle()

  if (!data) throw new PostNotFoundError()
  // Redundante com a RLS, e de propósito.
  if (data.owner_id !== user.id) throw new PostNotFoundError()
  if (!EDITABLE_STATUSES.includes(data.status as 'draft' | 'scheduled')) {
    throw new NotEditableError(data.status)
  }

  return { user, post: data }
}

export async function reschedule(
  postId: string,
  when: { date: string; time: string; timeZone: string; occurrence?: number },
): Promise<void> {
  const { user } = await carregarEditavel(postId)
  // Lança em horário inexistente e em ambíguo sem escolha explícita.
  const utc = toUtc(when, { occurrence: when.occurrence })

  const admin = createAdminSupabase()
  const { error } = await admin.rpc('reschedule_scheduled_post', {
    p_owner_id: user.id,
    p_post_id: postId,
    p_scheduled_at: utc.toISOString(),
    p_timezone: when.timeZone,
  })
  if (error) throw error
}

export async function cancel(postId: string): Promise<void> {
  const { user } = await carregarEditavel(postId)

  // A RPC cancela o post e os comentários pendentes na mesma transação.
  const admin = createAdminSupabase()
  const { error } = await admin.rpc('cancel_scheduled_post', {
    p_owner_id: user.id,
    p_post_id: postId,
  })
  if (error) throw error
}
