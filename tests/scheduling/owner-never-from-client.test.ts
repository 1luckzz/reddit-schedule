import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { newPostSchema } from '@/app/(dashboard)/dashboard/new/schema'

/**
 * O dono de uma publicação vem sempre de requireUser(), que valida a
 * assinatura do JWT. Nenhum campo de formulário pode influenciar isso — caso
 * contrário, bastaria trocar um valor no navegador para agendar no nome de
 * outro usuário.
 */

const schemaSrc = readFileSync(
  'src/app/(dashboard)/dashboard/new/schema.ts',
  'utf8',
)
const createSrc = readFileSync('src/lib/scheduling/create-post.ts', 'utf8')
const actionSrc = readFileSync(
  'src/app/(dashboard)/dashboard/new/actions.ts',
  'utf8',
)
const updateSrc = readFileSync('src/lib/scheduling/update-post.ts', 'utf8')

describe('o schema não aceita owner do cliente', () => {
  it('não declara nenhum campo de owner', () => {
    expect(schemaSrc).not.toMatch(/owner_?[Ii]d\s*:/)
  })

  it('descarta owner_id enviado no formulário', () => {
    const comOwner = {
      owner_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      ownerId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      accountId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
      subredditId: '3f2504e0-4f89-11d3-9a0c-0305e82c3303',
      title: 'Título',
      url: 'https://exemplo.com/v',
      body: '',
      flairId: '',
      date: '',
      time: '',
      timeZone: 'America/Sao_Paulo',
      publishMode: 'now',
      occurrence: '',
      commentBody: '',
      commentMode: 'immediate',
      commentDelayMinutes: '',
      commentDate: '',
      commentTime: '',
    }

    const r = newPostSchema.parse(comOwner)
    // Zod devolve apenas as chaves declaradas: o owner some no parse.
    expect(Object.keys(r)).not.toContain('owner_id')
    expect(Object.keys(r)).not.toContain('ownerId')
  })
})

describe('a criação deriva o owner da sessão', () => {
  it('chama requireUser antes de montar o payload', () => {
    const posRequire = createSrc.indexOf('await requireUser()')
    const posRpc = createSrc.indexOf("rpc('create_scheduled_post'")
    expect(posRequire).toBeGreaterThan(-1)
    expect(posRequire).toBeLessThan(posRpc)
  })

  it('passa p_owner_id vindo de user.id, não do input', () => {
    expect(createSrc).toMatch(/p_owner_id:\s*user\.id/)
    expect(createSrc).not.toMatch(/p_owner_id:\s*input\./)
    expect(createSrc).not.toMatch(/p_owner_id:\s*\w*[Bb]ruto/)
  })

  it('usa o client administrativo para a RPC, que é exclusiva do backend', () => {
    expect(createSrc).toContain('createAdminSupabase')
  })

  it('usa o client do usuário para ler a comunidade, com RLS', () => {
    const trecho = createSrc.slice(
      createSrc.indexOf('createServerSupabase'),
      createSrc.indexOf('--- horário ---'),
    )
    expect(trecho).toContain("from('subreddits')")
  })

  it('a action não atribui owner: apenas repassa a entrada validada', () => {
    // Procura atribuição, não menção: os comentários explicam a regra e
    // citar "owner" ali é legítimo.
    expect(actionSrc).not.toMatch(/p_owner_id\s*:/)
    expect(actionSrc).not.toMatch(/owner_?[Ii]d\s*[:=]/)
  })
})

describe('reagendamento e cancelamento derivam o owner da sessão', () => {
  it('chamam requireUser', () => {
    expect(updateSrc).toContain('requireUser')
  })

  it('passam p_owner_id de user.id', () => {
    const ocorrencias = updateSrc.match(/p_owner_id:\s*[\w.]+/g) ?? []
    expect(ocorrencias.length).toBeGreaterThanOrEqual(2)
    for (const o of ocorrencias) {
      expect(o).toMatch(/p_owner_id:\s*user\.id/)
    }
  })

  it('usam o client administrativo para as RPCs', () => {
    expect(updateSrc).toContain('createAdminSupabase')
  })
})

describe('o service_role fica restrito ao servidor', () => {
  it('o módulo admin é server-only', () => {
    const adminSrc = readFileSync('src/lib/supabase/admin.ts', 'utf8')
    expect(adminSrc).toContain("import 'server-only'")
  })

  it('nenhum componente de cliente importa o admin', () => {
    for (const arquivo of [
      'src/components/posts/new-post-form.tsx',
      'src/components/accounts/network-form.tsx',
      'src/components/communities/sync-button.tsx',
    ]) {
      const src = readFileSync(arquivo, 'utf8')
      expect(src).toContain("'use client'")
      expect(src).not.toContain('createAdminSupabase')
      expect(src).not.toContain('SUPABASE_SECRET_KEY')
    }
  })
})
