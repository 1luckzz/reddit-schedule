'use server'

import { revalidatePath } from 'next/cache'
import { ForbiddenError } from '@/lib/auth/ownership'
import { UnauthenticatedError } from '@/lib/auth/require-user'
import { RedditError } from '@/lib/reddit/errors'
import { createPost, SubredditMismatchError } from '@/lib/scheduling/create-post'
import { PayloadError } from '@/lib/scheduling/payload-builder'
import {
  AmbiguousTimeError,
  NonexistentTimeError,
} from '@/lib/scheduling/timezone'
import { newPostSchema, type CreateState } from './schema'

const vazio = { fieldError: null, postId: null, timeChoices: null }

export async function createScheduledPost(
  _prev: CreateState,
  formData: FormData,
): Promise<CreateState> {
  // O formulário não tem campo de owner, e o schema não o aceitaria: o dono
  // vem de requireUser() dentro de createPost.
  const bruto = Object.fromEntries(formData.entries())
  const parsed = newPostSchema.safeParse(bruto)

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ...vazio,
      error: issue.message,
      fieldError: String(issue.path[0] ?? ''),
    }
  }

  try {
    const { postId } = await createPost(parsed.data)
    revalidatePath('/dashboard/queue')
    revalidatePath('/dashboard/calendar')
    return { error: null, fieldError: null, postId, timeChoices: null }
  } catch (e) {
    if (e instanceof AmbiguousTimeError) {
      // Não escolhemos pelo usuário: devolvemos as opções com o offset de
      // cada uma para ele decidir.
      return {
        ...vazio,
        error: e.message,
        fieldError: 'time',
        timeChoices: e.occurrences.map((o, index) => ({
          index,
          offsetLabel: o.offsetLabel,
          utcIso: o.utc.toISOString(),
        })),
      }
    }
    if (e instanceof NonexistentTimeError) {
      return { ...vazio, error: e.message, fieldError: 'time' }
    }
    if (e instanceof PayloadError) {
      return { ...vazio, error: e.userMessage, fieldError: e.field }
    }
    if (e instanceof SubredditMismatchError) {
      return { ...vazio, error: e.message, fieldError: 'subredditId' }
    }
    if (e instanceof ForbiddenError) {
      return { ...vazio, error: 'Conta não encontrada.', fieldError: 'accountId' }
    }
    if (e instanceof UnauthenticatedError) {
      return { ...vazio, error: 'Sessão expirada. Entre novamente.' }
    }
    if (e instanceof RedditError) {
      // Inclui REQUIREMENTS_UNAVAILABLE, orçamento e conta desconectada.
      return { ...vazio, error: e.userMessage }
    }
    return { ...vazio, error: 'Não foi possível agendar a publicação agora.' }
  }
}
