import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const authorize = readFileSync('src/app/api/reddit/authorize/route.ts', 'utf8')
const callback = readFileSync('src/app/api/reddit/callback/route.ts', 'utf8')

describe('rota de authorize', () => {
  it('roda no runtime Node, onde ProxyAgent existe', () => {
    expect(authorize).toMatch(/export const runtime = 'nodejs'/)
  })

  it('exige sessão antes de gerar o state', () => {
    const antesDoState = authorize.slice(0, authorize.indexOf('createOAuthState'))
    expect(antesDoState).toContain('requireUser')
  })

  it('marca o cookie do state como httpOnly', () => {
    expect(authorize).toContain('httpOnly: cookie.httpOnly')
  })
})

describe('rota de callback', () => {
  it('roda no runtime Node', () => {
    expect(callback).toMatch(/export const runtime = 'nodejs'/)
  })

  it('compara o state da query com o cookie antes de qualquer troca', () => {
    // Ancorar na chamada, não no identificador: ele também aparece no import.
    const antesDaTroca = callback.slice(0, callback.indexOf('await exchangeCode'))
    expect(antesDaTroca).toContain('cookie !== state')
    expect(antesDaTroca).toContain('state_invalido')
  })

  it('consome o state antes de chamar o Reddit', () => {
    const consumo = callback.indexOf('consumeOAuthState')
    const troca = callback.indexOf('await exchangeCode')
    expect(consumo).toBeGreaterThan(-1)
    expect(consumo).toBeLessThan(troca)
  })

  it('apaga o cookie de state em qualquer desfecho', () => {
    // A limpeza mora na função `back`, usada por todos os caminhos de retorno.
    expect(callback).toContain('response.cookies.delete(STATE_COOKIE)')
    const retornos = callback.match(/return back\(/g) ?? []
    expect(retornos.length).toBeGreaterThanOrEqual(4)
  })

  it('trata recusa do usuário no Reddit sem tratar como falha', () => {
    expect(callback).toContain('autorizacao_recusada')
  })

  it('distingue conta já conectada por outro usuário', () => {
    expect(callback).toContain('AccountTakenError')
    expect(callback).toContain('conta_em_uso')
  })

  it('sanitiza o erro antes de qualquer log', () => {
    expect(callback).toMatch(/console\.error\([^)]*sanitize\(/)
  })

  it('nunca loga o code, o state ou o token', () => {
    const logs = callback.match(/console\.\w+\([^\n]*/g) ?? []
    for (const linha of logs) {
      expect(linha).not.toMatch(/\bcode\b|\bstate\b|token/)
    }
  })
})
