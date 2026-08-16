import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { getCoreEnv } from '@/lib/config/env'

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`Falha ao decifrar o segredo: ${reason}`)
    this.name = 'DecryptionError'
  }
}

function key(): Buffer {
  return Buffer.from(getCoreEnv().ENCRYPTION_KEY, 'base64')
}

/**
 * Cifra um segredo para armazenamento.
 *
 * O `aad` amarra o texto cifrado ao seu contexto — por exemplo
 * `reddit_account_secrets:refresh_token:<accountId>`. Sem ele, quem tivesse
 * escrita no banco poderia mover o token da conta A para a linha da conta B
 * e o sistema o decifraria normalmente. Com ele, a decifragem falha.
 */
export function encryptSecret(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decryptSecret(payload: string, aad: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4) throw new DecryptionError('formato inválido')
  const [version, ivB64, tagB64, ctB64] = parts
  if (version !== VERSION) throw new DecryptionError('versão não suportada')

  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('formato inválido')
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // A causa original é omitida de propósito: pode carregar fragmentos do
    // material criptográfico para dentro de logs.
    throw new DecryptionError('autenticação falhou')
  }
}
