// tests/posts/form-security.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync(
  'src/app/(dashboard)/dashboard/new/page.tsx',
  'utf8',
)
const form = readFileSync('src/components/posts/new-post-form.tsx', 'utf8')
const flairs = readFileSync('src/app/api/reddit/flairs/route.ts', 'utf8')
const actions = readFileSync(
  'src/app/(dashboard)/dashboard/new/actions.ts',
  'utf8',
)

describe('página de nova publicação', () => {
  it('lê dados com o client do usuário', () => {
    expect(page).toContain('createServerSupabase')
    expect(page).not.toContain('createAdminSupabase')
  })

  it('oferece apenas comunidades ativas', () => {
    expect(page).toContain("'active'")
  })

  it('não seleciona colunas sensíveis', () => {
    for (const proibido of ['access_token', 'refresh_token', 'proxy_password']) {
      expect(page).not.toContain(proibido)
    }
  })
})

describe('formulário', () => {
  it('filtra comunidades pela conta escolhida', () => {
    expect(form).toMatch(/reddit_account_id|accountId/)
  })

  it('explica a limitação de link + texto', () => {
    expect(form).toMatch(/coment/i)
    expect(form).toMatch(/não permite|nao permite|não aceita/i)
  })

  it('tem confirmação explícita para o comentário automático', () => {
    expect(form).toContain('allowCommentFallback')
  })

  it('usa o fuso padrão da spec', () => {
    expect(form).toContain('America/Sao_Paulo')
  })

  it('oferece publicar agora e agendar', () => {
    expect(form).toContain('publishMode')
    expect(form).toMatch(/Publicar agora/i)
    expect(form).toMatch(/Programar/i)
  })
})

describe('endpoint de flairs', () => {
  it('roda no runtime Node', () => {
    expect(flairs).toMatch(/export const runtime = 'nodejs'/)
  })

  it('verifica a posse da conta antes de consultar', () => {
    expect(flairs).toContain('assertAccountAccess')
  })

  it('distingue indisponibilidade de ausência de flair', () => {
    expect(flairs).toContain('FLAIRS_UNAVAILABLE')
  })
})

describe('action de criação', () => {
  it('devolve o campo responsável pelo erro', () => {
    expect(actions).toContain('fieldError')
  })

  it('trata erro de requisitos indisponíveis', () => {
    expect(actions).toContain('RedditError')
  })
})
