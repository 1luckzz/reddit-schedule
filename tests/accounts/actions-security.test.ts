import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/app/(dashboard)/dashboard/accounts/actions.ts', 'utf8')
const page = readFileSync('src/app/(dashboard)/dashboard/accounts/page.tsx', 'utf8')
const form = readFileSync('src/components/accounts/network-form.tsx', 'utf8')

describe('server actions de contas', () => {
  it('toda action passa por assertAccountAccess antes de tocar em segredo', () => {
    const actions = source
      .split('export async function')
      .slice(1)
      .filter((bloco) => bloco.includes('accountId'))
    expect(actions.length).toBeGreaterThanOrEqual(4)
    for (const bloco of actions) {
      expect(bloco).toContain('assertAccountAccess')
    }
  })

  it('nenhuma action usa o client administrativo diretamente', () => {
    // O acesso a segredos passa sempre pelos helpers tipados de lib/reddit.
    const usaAdmin = source
      .split('\n')
      .some((l) => l.includes('createAdminSupabase') && !l.trim().startsWith('//'))
    expect(usaAdmin).toBe(false)
  })

  it('valida a entrada com Zod', () => {
    expect(source).toContain('networkConfigSchema')
    expect(source).toContain('safeParse')
  })

  it('nunca devolve senha ao cliente', () => {
    expect(source).not.toMatch(/return\s*\{[^}]*password/)
  })

  it('existe ação dedicada para remover credenciais do proxy', () => {
    expect(source).toContain('clearProxyCredentials')
    expect(form).toContain('Remover credenciais')
  })
})

describe('página de contas', () => {
  it('lê o status de rede pela view, nunca pela tabela de configuração', () => {
    expect(page).toContain('reddit_account_network_status')
    expect(page).not.toContain('reddit_account_network_configs')
  })

  it('não seleciona nenhuma coluna sensível', () => {
    for (const proibido of [
      'proxy_password',
      'proxy_username',
      'access_token',
      'refresh_token',
    ]) {
      expect(page).not.toContain(proibido)
    }
  })

  it('exibe apenas o host mascarado', () => {
    expect(page).toContain('proxy_host_masked')
    expect(page).not.toMatch(/proxy_host[^_]/)
  })
})

describe('formulário de rede', () => {
  it('o campo de senha nunca recebe valor pré-preenchido', () => {
    const bloco = form.slice(form.indexOf('name="password"'))
    expect(bloco.slice(0, 200)).not.toContain('defaultValue')
    expect(bloco.slice(0, 200)).not.toContain('value=')
  })

  it('oferece apenas os protocolos suportados, marcando o experimental', () => {
    expect(form).toContain('SUPPORTED_PROXY_PROTOCOLS')
    expect(form).toContain('isExperimentalProtocol')
  })

  it('deixa explícito que a rota é fixa, sem rotação', () => {
    expect(form).toMatch(/sem rota|rota é fixa|não há rotação/i)
  })
})
