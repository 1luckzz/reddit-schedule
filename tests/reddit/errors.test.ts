import { describe, expect, it } from 'vitest'
import { classifyHttp, classifyNetwork, RedditError } from '@/lib/reddit/errors'

describe('classifyHttp em requisição de efeito', () => {
  const efeito = true

  it('200 sem erros não gera erro', () => {
    expect(classifyHttp(200, { json: { errors: [] } }, efeito)).toBeNull()
  })

  it('200 com json.errors é terminal', () => {
    const e = classifyHttp(
      200,
      { json: { errors: [['NO_TEXT', 'we need something here', 'title']] } },
      efeito,
    )
    expect(e).toBeInstanceOf(RedditError)
    expect(e!.disposition).toBe('terminal')
  })

  it('429 é retryable', () => {
    const e = classifyHttp(429, {}, efeito)
    expect(e!.disposition).toBe('retryable')
    expect(e!.code).toBe('RATE_LIMITED')
  })

  it.each([500, 502, 503, 504])(
    '%i é unknown em requisição de efeito',
    (status) => {
      const e = classifyHttp(status, {}, efeito)
      expect(e!.disposition).toBe('unknown')
      expect(e!.code).toBe('OUTCOME_UNKNOWN')
    },
  )

  it('403 é terminal e fala de permissão', () => {
    const e = classifyHttp(403, {}, efeito)
    expect(e!.disposition).toBe('terminal')
    expect(e!.code).toBe('NO_PERMISSION')
    expect(e!.userMessage).toMatch(/permiss/i)
  })

  it('404 é terminal', () => {
    expect(classifyHttp(404, {}, efeito)!.disposition).toBe('terminal')
  })

  it('401 é terminal e indica token inválido', () => {
    const e = classifyHttp(401, {}, efeito)
    expect(e!.code).toBe('TOKEN_INVALID')
    expect(e!.disposition).toBe('terminal')
  })

  it('400 é terminal', () => {
    expect(classifyHttp(400, {}, efeito)!.disposition).toBe('terminal')
  })
})

describe('classifyHttp em requisição de leitura', () => {
  const leitura = false

  it.each([500, 502, 503, 504])('%i é retryable em leitura', (status) => {
    const e = classifyHttp(status, {}, leitura)
    expect(e!.disposition).toBe('retryable')
    expect(e!.code).toBe('REDDIT_UNAVAILABLE')
  })

  it('429 continua retryable', () => {
    expect(classifyHttp(429, {}, leitura)!.disposition).toBe('retryable')
  })

  it('403 continua terminal', () => {
    expect(classifyHttp(403, {}, leitura)!.disposition).toBe('terminal')
  })
})

describe('classifyNetwork', () => {
  it('DNS antes do envio é retryable', () => {
    const e = classifyNetwork(
      Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
  })

  it('conexão recusada antes do envio é retryable', () => {
    const e = classifyNetwork(
      Object.assign(new Error('recusada'), { code: 'ECONNREFUSED' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
  })

  it('timeout de conexão antes do envio é retryable', () => {
    const e = classifyNetwork(
      Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
  })

  it('reset APÓS o envio é unknown', () => {
    const e = classifyNetwork(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      true,
    )
    expect(e.disposition).toBe('unknown')
  })

  it('timeout de headers APÓS o envio é unknown', () => {
    const e = classifyNetwork(
      Object.assign(new Error('headers'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
      true,
    )
    expect(e.disposition).toBe('unknown')
  })

  it('mesmo um ECONNREFUSED marcado como pós-envio vira unknown', () => {
    // Conservador de propósito: na dúvida, revisão humana em vez de duplicata.
    const e = classifyNetwork(
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      true,
    )
    expect(e.disposition).toBe('unknown')
  })

  it('falha de proxy é retryable quando nada foi enviado', () => {
    const e = classifyNetwork(
      Object.assign(new Error('proxy'), { code: 'UND_ERR_PROXY' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
    expect(e.code).toBe('PROXY_UNAVAILABLE')
  })

  it('código desconhecido antes do envio é retryable', () => {
    const e = classifyNetwork(new Error('vixe'), false)
    expect(e.disposition).toBe('retryable')
    expect(e.code).toBe('NETWORK_ERROR')
  })
})

describe('mensagens ao usuário', () => {
  it('toda mensagem é legível e sem jargão de infraestrutura', () => {
    const erros = [
      classifyHttp(403, {}, true)!,
      classifyHttp(429, {}, true)!,
      classifyHttp(500, {}, true)!,
      classifyNetwork(Object.assign(new Error(''), { code: 'ENOTFOUND' }), false),
    ]
    for (const e of erros) {
      expect(e.userMessage.length).toBeGreaterThan(10)
      expect(e.userMessage).not.toMatch(/undefined|null|ENOTFOUND|ECONN/)
    }
  })

  it('nenhuma mensagem vaza token', () => {
    const e = classifyHttp(401, { access_token: 'AT-123' }, true)!
    expect(JSON.stringify(e.userMessage)).not.toContain('AT-123')
  })

  it('o erro de resultado desconhecido pede revisão manual', () => {
    const e = classifyHttp(503, {}, true)!
    expect(e.userMessage).toMatch(/revis/i)
  })
})
