import { describe, expect, it } from 'vitest'
import { maskHost, sanitize } from '@/lib/logging/sanitize'

const REDACTED = '[REDACTED]'

describe('sanitize', () => {
  it('remove todas as chaves sensíveis conhecidas', () => {
    const input = {
      access_token: 'AT-123',
      refresh_token: 'RT-456',
      client_secret: 'CS-789',
      proxy_password: 'PP-000',
      authorization: 'bearer AT-123',
      cookie: 'sb-x-auth-token=abc',
      title: 'Meu post',
    }
    const out = sanitize(input) as Record<string, unknown>
    expect(out.access_token).toBe(REDACTED)
    expect(out.refresh_token).toBe(REDACTED)
    expect(out.client_secret).toBe(REDACTED)
    expect(out.proxy_password).toBe(REDACTED)
    expect(out.authorization).toBe(REDACTED)
    expect(out.cookie).toBe(REDACTED)
    expect(out.title).toBe('Meu post')
  })

  it('reconhece variações de caixa e separador', () => {
    const out = sanitize({
      Authorization: 'bearer x',
      'Access-Token': 'y',
      accessToken: 'z',
      PROXY_PASSWORD: 'w',
      ENCRYPTION_KEY: 'k',
      'set-cookie': 'c',
    }) as Record<string, unknown>
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true)
  })

  it('desce em objetos aninhados e arrays', () => {
    const out = sanitize({
      accounts: [{ secrets: { refresh_token: 'RT' } }],
    }) as { accounts: { secrets: { refresh_token: string } }[] }
    expect(out.accounts[0].secrets.refresh_token).toBe(REDACTED)
  })

  it('remove credenciais embutidas em URL de proxy', () => {
    const out = sanitize({
      note: 'usando socks5://usuario:senha@proxy.exemplo.com:1080 agora',
    }) as { note: string }
    expect(out.note).not.toContain('senha')
    expect(out.note).not.toContain('usuario')
    expect(out.note).toContain('socks5://')
    expect(out.note).toContain('proxy.exemplo.com')
  })

  it('remove tokens bearer soltos em texto livre', () => {
    const out = sanitize(
      'falhou com Authorization: bearer eyJhbGciOiJIUzI1',
    ) as string
    expect(out).not.toContain('eyJhbGciOiJIUzI1')
  })

  it('preserva o formato de Error mas sanitiza a mensagem', () => {
    const out = sanitize(new Error('bearer eyJabc falhou')) as {
      name: string
      message: string
    }
    expect(out.name).toBe('Error')
    expect(out.message).not.toContain('eyJabc')
  })

  it('não altera valores não sensíveis', () => {
    const out = sanitize({ status: 429, ok: false, id: null }) as Record<
      string,
      unknown
    >
    expect(out).toEqual({ status: 429, ok: false, id: null })
  })

  it('não entra em laço infinito com referência circular', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(() => sanitize(a)).not.toThrow()
  })
})

describe('maskHost', () => {
  it('mascara hostname preservando o domínio', () => {
    expect(maskHost('proxy.exemplo.com')).toBe('pr***.exemplo.com')
  })

  it('mascara o último octeto de um IPv4', () => {
    expect(maskHost('203.0.113.9')).toBe('203.0.113.***')
  })

  it('mascara host curto por inteiro', () => {
    expect(maskHost('a.b')).toBe('***.b')
  })

  it('mascara host sem ponto por inteiro', () => {
    expect(maskHost('localhost')).toBe('***')
  })
})
