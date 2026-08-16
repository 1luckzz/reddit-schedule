import { describe, expect, it } from 'vitest'
import { credentialsSchema } from '@/app/(auth)/login/schema'

describe('credentialsSchema', () => {
  it('aceita credenciais válidas', () => {
    const r = credentialsSchema.safeParse({
      email: 'user@exemplo.com',
      password: 'senha-forte-123',
    })
    expect(r.success).toBe(true)
  })

  it('rejeita email malformado', () => {
    const r = credentialsSchema.safeParse({
      email: 'nao-e-email',
      password: 'senha-forte-123',
    })
    expect(r.success).toBe(false)
  })

  it('rejeita senha com menos de 8 caracteres', () => {
    const r = credentialsSchema.safeParse({
      email: 'user@exemplo.com',
      password: '1234567',
    })
    expect(r.success).toBe(false)
  })

  it('rejeita campos ausentes', () => {
    expect(credentialsSchema.safeParse({}).success).toBe(false)
  })

  it('normaliza o email removendo espaços e caixa alta', () => {
    const r = credentialsSchema.parse({
      email: '  User@Exemplo.COM ',
      password: 'senha-forte-123',
    })
    expect(r.email).toBe('user@exemplo.com')
  })

  it('a mensagem de erro é legível em português', () => {
    const r = credentialsSchema.safeParse({
      email: 'x',
      password: 'senha-forte-123',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Informe um email válido.')
    }
  })
})
