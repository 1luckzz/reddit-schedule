'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  AmbiguousTimeError,
  NonexistentTimeError,
  SUPPORTED_TIME_ZONES,
} from '@/lib/scheduling/timezone'
import {
  cancel,
  NotEditableError,
  PostNotFoundError,
  reschedule,
} from '@/lib/scheduling/update-post'

export type QueueState = { error: string | null; ok: boolean }

// Sem campo de owner: ele vem de requireUser() dentro de update-post.
const rescheduleSchema = z.object({
  postId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data.'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Informe o horário.'),
  timeZone: z.enum(SUPPORTED_TIME_ZONES),
  occurrence: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v))),
})

function traduzir(e: unknown): string {
  // AmbiguousTimeError também cai aqui: a mensagem já pede a escolha, e a
  // interface de fila reenvia com `occurrence`.
  if (e instanceof AmbiguousTimeError) return e.message
  if (e instanceof NonexistentTimeError) return e.message
  if (e instanceof NotEditableError) return e.message
  if (e instanceof PostNotFoundError) return e.message
  return 'Não foi possível concluir a operação agora.'
}

export async function reschedulePost(
  _prev: QueueState,
  formData: FormData,
): Promise<QueueState> {
  const parsed = rescheduleSchema.safeParse(
    Object.fromEntries(formData.entries()),
  )
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, ok: false }
  }

  try {
    await reschedule(parsed.data.postId, {
      date: parsed.data.date,
      time: parsed.data.time,
      timeZone: parsed.data.timeZone,
      occurrence: parsed.data.occurrence,
    })
  } catch (e) {
    return { error: traduzir(e), ok: false }
  }

  revalidatePath('/dashboard/queue')
  revalidatePath('/dashboard/calendar')
  return { error: null, ok: true }
}

export async function cancelPost(
  _prev: QueueState,
  formData: FormData,
): Promise<QueueState> {
  const parsed = z
    .object({ postId: z.uuid() })
    .safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: 'Publicação inválida.', ok: false }
  }

  try {
    await cancel(parsed.data.postId)
  } catch (e) {
    return { error: traduzir(e), ok: false }
  }

  revalidatePath('/dashboard/queue')
  revalidatePath('/dashboard/calendar')
  return { error: null, ok: true }
}
