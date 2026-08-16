import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildProxyUrl,
  createDispatcherFor,
} from '@/lib/reddit/reddit-client-factory'
import { sanitize } from '@/lib/logging/sanitize'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')
})

const base = {
  enabled: true as const,
  host: 'proxy.exemplo.com',
  port: 1080,
  username: 'usuario',
  password: 'senha-secreta',
}

describe('buildProxyUrl', () => {
  it('monta URL socks5 com credenciais', () => {
    const url = buildProxyUrl({ ...base, protocol: 'socks5' })
    expect(url).toBe('socks5://usuario:senha-secreta@proxy.exemplo.com:1080')
  })

  it('monta URL http sem credenciais quando não há usuário', () => {
    const url = buildProxyUrl({
      ...base,
      protocol: 'http',
      username: null,
      password: null,
    })
    expect(url).toBe('http://proxy.exemplo.com:1080')
  })

  it('escapa caracteres especiais na senha', () => {
    const url = buildProxyUrl({ ...base, protocol: 'http', password: 'a@b:c/d' })
    expect(url).toContain('a%40b%3Ac%2Fd')
    expect(url).toContain('@proxy.exemplo.com:1080')
  })

  it('a URL montada é redigida pelo sanitizador de logs', () => {
    const url = buildProxyUrl({ ...base, protocol: 'socks5' })
    const seguro = sanitize({ note: `conectando em ${url}` }) as { note: string }
    expect(seguro.note).not.toContain('senha-secreta')
    expect(seguro.note).not.toContain('usuario')
  })
})

describe('createDispatcherFor', () => {
  it('devolve undefined quando não há configuração de rede', () => {
    expect(createDispatcherFor(null)).toBeUndefined()
  })

  it.each(['http', 'https', 'socks5'] as const)(
    'constrói dispatcher para %s',
    (protocol) => {
      const d = createDispatcherFor({ ...base, protocol })
      expect(d).toBeDefined()
    },
  )

  it('não expõe a senha em propriedades enumeráveis do dispatcher', () => {
    const d = createDispatcherFor({ ...base, protocol: 'http' })
    expect(JSON.stringify(d ?? {})).not.toContain('senha-secreta')
  })
})
