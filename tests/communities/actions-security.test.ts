import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const actions = readFileSync(
  'src/app/(dashboard)/dashboard/communities/actions.ts',
  'utf8',
)
const page = readFileSync(
  'src/app/(dashboard)/dashboard/communities/page.tsx',
  'utf8',
)

describe('server action de sincronização', () => {
  it('verifica a posse da conta antes de sincronizar', () => {
    const bloco = actions.slice(actions.indexOf('export async function'))
    expect(bloco).toContain('assertAccountAccess')
    const posse = bloco.indexOf('assertAccountAccess')
    const sync = bloco.indexOf('syncCommunitiesFor(account')
    expect(posse).toBeLessThan(sync)
  })

  it('não usa o client administrativo diretamente', () => {
    const usaAdmin = actions
      .split('\n')
      .some((l) => l.includes('createAdminSupabase') && !l.trim().startsWith('//'))
    expect(usaAdmin).toBe(false)
  })

  it('repassa a mensagem pronta dos erros do Reddit', () => {
    expect(actions).toContain('RedditError')
    expect(actions).toContain('e.userMessage')
  })

  it('valida o accountId recebido do formulário', () => {
    expect(actions).toContain('z.uuid()')
    expect(actions).toContain('safeParse')
  })
})

describe('página de comunidades', () => {
  it('lê comunidades pelo client do usuário, com RLS', () => {
    expect(page).toContain('createServerSupabase')
    expect(page).not.toContain('createAdminSupabase')
  })

  it('esconde as comunidades removidas por padrão', () => {
    expect(page).toContain("'active'")
  })

  it('não seleciona nenhuma coluna sensível', () => {
    for (const proibido of ['access_token', 'refresh_token', 'proxy_password']) {
      expect(page).not.toContain(proibido)
    }
  })

  it('só oferece sincronização para conta conectada', () => {
    expect(page).toContain("conta.status === 'connected'")
  })
})
