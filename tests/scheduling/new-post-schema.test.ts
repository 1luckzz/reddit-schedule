// tests/scheduling/new-post-schema.test.ts
import { describe, expect, it } from 'vitest'
import { newPostSchema } from '@/app/(dashboard)/dashboard/new/schema'

const base = {
  accountId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  subredditId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  title: 'Meu título',
  url: 'https://exemplo.com/v',
  body: '',
  flairId: '',
  nsfw: 'off',
  spoiler: 'off',
  date: '2026-09-01',
  time: '10:30',
  timeZone: 'America/Sao_Paulo',
  publishMode: 'schedule',
  addComment: 'off',
  commentBody: '',
  commentMode: 'immediate',
  commentDelayMinutes: '',
  allowCommentFallback: 'off',
}

describe('newPostSchema', () => {
  it('aceita um agendamento completo', () => {
    expect(newPostSchema.safeParse(base).success).toBe(true)
  })

  it('converte checkboxes de on/off para booleano', () => {
    const r = newPostSchema.parse({ ...base, nsfw: 'on', spoiler: 'on' })
    expect(r.nsfw).toBe(true)
    expect(r.spoiler).toBe(true)
  })

  it('trata checkbox ausente como falso', () => {
    // Checkbox desmarcado simplesmente não é enviado pelo formulário HTML.
    const semNsfw: Record<string, string> = { ...base }
    delete semNsfw.nsfw
    expect(newPostSchema.parse(semNsfw).nsfw).toBe(false)
  })

  it('recusa UUID inválido', () => {
    expect(newPostSchema.safeParse({ ...base, accountId: 'x' }).success).toBe(
      false,
    )
  })

  it('recusa título vazio', () => {
    expect(newPostSchema.safeParse({ ...base, title: '   ' }).success).toBe(
      false,
    )
  })

  it('recusa título acima de 300 caracteres', () => {
    expect(
      newPostSchema.safeParse({ ...base, title: 'x'.repeat(301) }).success,
    ).toBe(false)
  })

  it('recusa fuso fora da lista suportada', () => {
    expect(
      newPostSchema.safeParse({ ...base, timeZone: 'Marte/Olympus' }).success,
    ).toBe(false)
  })

  it('recusa data malformada', () => {
    expect(newPostSchema.safeParse({ ...base, date: '01/09/2026' }).success).toBe(
      false,
    )
  })

  it('recusa hora malformada', () => {
    expect(newPostSchema.safeParse({ ...base, time: '25:00' }).success).toBe(
      false,
    )
  })

  it('dispensa data e hora quando é publicação imediata', () => {
    const r = newPostSchema.safeParse({
      ...base,
      publishMode: 'now',
      date: '',
      time: '',
    })
    expect(r.success).toBe(true)
  })

  it('exige data e hora quando é agendamento', () => {
    expect(
      newPostSchema.safeParse({ ...base, date: '', time: '' }).success,
    ).toBe(false)
  })

  it('exige corpo do comentário quando o comentário está ativo', () => {
    expect(
      newPostSchema.safeParse({ ...base, addComment: 'on', commentBody: '' })
        .success,
    ).toBe(false)
  })

  it('exige minutos quando o modo do comentário é delay', () => {
    expect(
      newPostSchema.safeParse({
        ...base,
        addComment: 'on',
        commentBody: 'texto',
        commentMode: 'delay',
        commentDelayMinutes: '',
      }).success,
    ).toBe(false)
  })

  it('aceita comentário com atraso em minutos', () => {
    const r = newPostSchema.parse({
      ...base,
      addComment: 'on',
      commentBody: 'texto',
      commentMode: 'delay',
      commentDelayMinutes: '15',
    })
    expect(r.commentDelayMinutes).toBe(15)
  })
})
