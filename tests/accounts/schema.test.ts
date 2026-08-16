import { describe, expect, it } from 'vitest'
import { networkConfigSchema } from '@/app/(dashboard)/dashboard/accounts/schema'
import { SUPPORTED_PROXY_PROTOCOLS } from '@/lib/reddit/proxy-support'

const valido = {
  accountId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  protocol: 'socks5',
  host: 'proxy.exemplo.com',
  port: '1080',
  username: 'usuario',
  password: 'senha-secreta',
}

describe('networkConfigSchema', () => {
  it('aceita uma configuração completa', () => {
    expect(networkConfigSchema.safeParse(valido).success).toBe(true)
  })

  it('aceita configuração sem credenciais', () => {
    const r = networkConfigSchema.safeParse({
      ...valido,
      username: '',
      password: '',
    })
    expect(r.success).toBe(true)
  })

  it('rejeita protocolo não suportado pela versão instalada do undici', () => {
    expect(networkConfigSchema.safeParse({ ...valido, protocol: 'ftp' }).success).toBe(
      false,
    )
  })

  it('só aceita os protocolos confirmados por teste', () => {
    for (const p of SUPPORTED_PROXY_PROTOCOLS) {
      expect(
        networkConfigSchema.safeParse({ ...valido, protocol: p }).success,
      ).toBe(true)
    }
  })

  it('rejeita porta fora da faixa', () => {
    expect(networkConfigSchema.safeParse({ ...valido, port: '0' }).success).toBe(
      false,
    )
    expect(
      networkConfigSchema.safeParse({ ...valido, port: '70000' }).success,
    ).toBe(false)
  })

  it('rejeita accountId que não é UUID', () => {
    expect(
      networkConfigSchema.safeParse({ ...valido, accountId: 'nao-e-uuid' })
        .success,
    ).toBe(false)
  })

  it('rejeita host vazio', () => {
    expect(networkConfigSchema.safeParse({ ...valido, host: '  ' }).success).toBe(
      false,
    )
  })

  it('converte a porta para número', () => {
    expect(networkConfigSchema.parse(valido).port).toBe(1080)
  })

  it('normaliza host e usuário removendo espaços', () => {
    const r = networkConfigSchema.parse({
      ...valido,
      host: '  proxy.exemplo.com  ',
      username: '  usuario  ',
    })
    expect(r.host).toBe('proxy.exemplo.com')
    expect(r.username).toBe('usuario')
  })
})
