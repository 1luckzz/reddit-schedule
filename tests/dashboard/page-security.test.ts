import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const codigo = (arquivo: string) =>
  readFileSync(arquivo, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const dashboard = codigo('src/app/(dashboard)/dashboard/page.tsx')
const settings = codigo('src/app/(dashboard)/dashboard/settings/page.tsx')
const logs = codigo('src/app/(dashboard)/dashboard/logs/page.tsx')

describe('Dashboard', () => {
  it('define "hoje" pelo fuso do perfil, não pelo do servidor', () => {
    // Em UTC, às 22h em São Paulo já é o dia seguinte: os contadores diriam
    // "nada hoje" e a pessoa acharia que o agendamento sumiu.
    expect(dashboard).toContain("from('profiles')")
    expect(dashboard).toContain('timezone')
    expect(dashboard).toContain('fromUtc(new Date(), fuso)')
    expect(dashboard).toContain('toUtc(')
  })

  it('valida o fuso lido do perfil', () => {
    expect(dashboard).toContain('SUPPORTED_TIME_ZONES')
  })

  it('o alerta de revisão só aparece quando há itens', () => {
    expect(dashboard).toContain('emRevisao > 0')
    expect(dashboard).toContain('/dashboard/review')
  })

  it('os contadores usam count, não trazem as linhas', () => {
    // Puxar todas as linhas só para contar traria dados sem uso ao servidor.
    expect(dashboard).toContain("count: 'exact'")
    expect(dashboard).toContain('head: true')
  })

  it('lê com o client do usuário', () => {
    expect(dashboard).toContain('createServerSupabase')
    expect(dashboard).not.toContain('createAdminSupabase')
  })
})

describe('Configurações', () => {
  it('NUNCA exibe o client secret, nem parcialmente', () => {
    for (const proibido of [
      'REDDIT_CLIENT_SECRET',
      'client_secret',
      'clientSecret',
      'getRedditEnv',
    ]) {
      expect(settings, proibido).not.toContain(proibido)
    }
    // Nem um prefixo: já reduziria o espaço de busca de quem tentar adivinhar.
    expect(settings).not.toMatch(/\.slice\(0,\s*\d+\)/)
  })

  it('avisa quando há publicações vencidas na fila', () => {
    // Este é o sinal confiável de worker parado: elas deveriam ter saído.
    expect(settings).toContain('saude.parado')
    expect(settings).toMatch(/venceram/i)
    expect(settings).toMatch(/worker não está rodando/i)
  })

  it('não confunde ociosidade com worker parado', () => {
    // Sem nada agendado, o worker não registra nada — e isso não é falha.
    // A regra em si é testada em tests/worker/health.test.ts.
    expect(settings).toContain('saude.ocioso && !saude.parado')
    expect(settings).toMatch(/esperado quando não há nada agendado/i)
  })

  it('a decisão de saúde não fica no meio do render', () => {
    // Ela é lógica de domínio, e mora em um módulo próprio e testável.
    expect(settings).toContain('avaliarSaude')
    expect(settings).not.toContain('Date.now()')
  })

  it('deixa claro que o intervalo é definido no ambiente do worker', () => {
    expect(settings).toMatch(/variáveis de ambiente/i)
  })

  it('lê com o client do usuário', () => {
    expect(settings).toContain('createServerSupabase')
    expect(settings).not.toContain('createAdminSupabase')
  })
})

describe('Logs', () => {
  it('não expõe coluna sensível', () => {
    for (const s of [
      'access_token',
      'refresh_token',
      'proxy_password',
      'proxy_host',
    ]) {
      expect(logs, s).not.toMatch(new RegExp(`\\b${s}\\b`))
    }
  })

  it('valida os filtros vindos da URL', () => {
    expect(logs).toContain('OUTCOMES')
    expect(logs).toContain('ACOES')
    expect(logs).toContain('.includes(params.action)')
    expect(logs).toContain('.includes(params.outcome)')
  })

  it('limita o número de linhas trazidas', () => {
    expect(logs).toMatch(/\.limit\(\d+\)/)
  })

  it('lê com o client do usuário', () => {
    expect(logs).toContain('createServerSupabase')
    expect(logs).not.toContain('createAdminSupabase')
  })

  it('não oferece nenhuma ação: é leitura', () => {
    expect(logs).not.toContain('useActionState')
    expect(logs).not.toMatch(/method="post"/i)
  })
})
