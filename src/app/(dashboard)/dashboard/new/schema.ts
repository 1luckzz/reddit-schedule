import { z } from 'zod'
import { SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

/**
 * NÃO existe campo de owner aqui, e é de propósito: o dono da publicação vem
 * sempre de requireUser() no servidor. Aceitar owner do formulário abriria o
 * caminho para agendar no nome de outro usuário.
 */

/**
 * Checkbox de formulário HTML chega como 'on' quando marcado e simplesmente
 * NÃO chega quando desmarcado — por isso `.optional()`: sem ele, a chave
 * ausente vira erro de campo obrigatório.
 */
const checkbox = z
  .union([z.literal('on'), z.literal('off')])
  .optional()
  .transform((v) => v === 'on')

export const newPostSchema = z
  .object({
    accountId: z.uuid(),
    subredditId: z.uuid(),
    title: z.string().trim().min(1, 'Informe o título.').max(300),
    url: z.string().trim().default(''),
    body: z.string().trim().default(''),
    flairId: z.string().trim().default(''),
    nsfw: checkbox,
    spoiler: checkbox,
    allowCommentFallback: checkbox,

    date: z.string().trim().default(''),
    time: z.string().trim().default(''),
    timeZone: z.enum(SUPPORTED_TIME_ZONES),
    publishMode: z.enum(['now', 'schedule']),
    /**
     * Qual instante usar quando o horário local ocorre duas vezes (fim do
     * horário de verão). Vem vazio na primeira tentativa; o formulário
     * pergunta e reenvia com a escolha.
     */
    occurrence: z
      .string()
      .trim()
      .default('')
      .transform((v) => (v === '' ? undefined : Number(v)))
      .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0), {
        message: 'Ocorrência inválida.',
      }),

    addComment: checkbox,
    commentBody: z.string().trim().default(''),
    commentMode: z.enum(['immediate', 'delay', 'absolute']),
    commentDelayMinutes: z
      .string()
      .trim()
      .default('')
      .transform((v) => (v === '' ? null : Number(v)))
      .refine((v) => v === null || (Number.isInteger(v) && v >= 0), {
        message: 'Informe os minutos como número inteiro.',
      }),
    commentDate: z.string().trim().default(''),
    commentTime: z.string().trim().default(''),
  })
  .superRefine((v, ctx) => {
    if (v.publishMode === 'schedule') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) {
        ctx.addIssue({
          code: 'custom',
          path: ['date'],
          message: 'Informe a data da publicação.',
        })
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) {
        ctx.addIssue({
          code: 'custom',
          path: ['time'],
          message: 'Informe o horário da publicação.',
        })
      }
    }

    if (v.addComment) {
      if (v.commentBody.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['commentBody'],
          message: 'Informe o texto do comentário.',
        })
      }
      if (v.commentMode === 'delay' && v.commentDelayMinutes === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['commentDelayMinutes'],
          message: 'Informe em quantos minutos o comentário deve ser enviado.',
        })
      }
      if (
        v.commentMode === 'absolute' &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(v.commentDate) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.commentTime))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['commentDate'],
          message: 'Informe data e horário do comentário.',
        })
      }
    }
  })

export type NewPostInput = z.infer<typeof newPostSchema>

export type TimeChoice = {
  /** Índice a reenviar em `occurrence`. */
  index: number
  /** Ex.: "UTC-04:00" */
  offsetLabel: string
  /** Instante correspondente, em ISO, para exibição. */
  utcIso: string
}

export type CreateState = {
  error: string | null
  /** Campo a destacar no formulário, quando o erro for de um campo. */
  fieldError: string | null
  postId: string | null
  /**
   * Preenchido quando o horário escolhido acontece duas vezes: o formulário
   * mostra as opções e reenvia com `occurrence`.
   */
  timeChoices: TimeChoice[] | null
}
