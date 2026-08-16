import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'

const AAD = 'reddit_account_secrets:refresh_token:acc-1'

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x'
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_x'
  process.env.APP_URL = 'http://localhost:3000'
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('encryptSecret / decryptSecret', () => {
  it('faz round-trip do texto original', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto/aes-gcm')
    const secret = 'refresh-token-super-secreto'
    expect(decryptSecret(encryptSecret(secret, AAD), AAD)).toBe(secret)
  })

  it('preserva caracteres acentuados e emoji', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto/aes-gcm')
    const secret = 'configuração de rede — proxy ✅'
    expect(decryptSecret(encryptSecret(secret, AAD), AAD)).toBe(secret)
  })

  it('produz saídas diferentes para a mesma entrada (IV aleatório)', async () => {
    const { encryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(encryptSecret('x', AAD)).not.toBe(encryptSecret('x', AAD))
  })

  it('não deixa o texto claro aparecer no payload', async () => {
    const { encryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(encryptSecret('token-visivel', AAD)).not.toContain('token-visivel')
  })

  it('recusa decifrar com AAD de outra conta', async () => {
    const { encryptSecret, decryptSecret, DecryptionError } = await import(
      '@/lib/crypto/aes-gcm'
    )
    const payload = encryptSecret('segredo', AAD)
    expect(() =>
      decryptSecret(payload, 'reddit_account_secrets:refresh_token:acc-2'),
    ).toThrow(DecryptionError)
  })

  it('recusa payload adulterado', async () => {
    const { encryptSecret, decryptSecret, DecryptionError } = await import(
      '@/lib/crypto/aes-gcm'
    )
    const payload = encryptSecret('segredo', AAD)
    const parts = payload.split('.')
    const bytes = Buffer.from(parts[3], 'base64url')
    bytes[0] ^= 0xff
    parts[3] = bytes.toString('base64url')
    expect(() => decryptSecret(parts.join('.'), AAD)).toThrow(DecryptionError)
  })

  it('recusa payload com versão desconhecida', async () => {
    const { decryptSecret, DecryptionError } = await import('@/lib/crypto/aes-gcm')
    expect(() => decryptSecret('v9.a.b.c', AAD)).toThrow(DecryptionError)
  })

  it('recusa payload com formato incompleto', async () => {
    const { decryptSecret, DecryptionError } = await import('@/lib/crypto/aes-gcm')
    expect(() => decryptSecret('v1.abc', AAD)).toThrow(DecryptionError)
  })

  it('recusa payload cifrado com outra chave', async () => {
    const { encryptSecret } = await import('@/lib/crypto/aes-gcm')
    const payload = encryptSecret('segredo', AAD)

    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
    const { decryptSecret, DecryptionError } = await import('@/lib/crypto/aes-gcm')
    expect(() => decryptSecret(payload, AAD)).toThrow(DecryptionError)
  })

  it('a mensagem de erro nunca inclui a chave nem o texto claro', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto/aes-gcm')
    const payload = encryptSecret('texto-claro-sensivel', AAD)
    try {
      decryptSecret(payload, 'aad-errado')
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain('texto-claro-sensivel')
      expect(msg).not.toContain(process.env.ENCRYPTION_KEY)
    }
  })
})
