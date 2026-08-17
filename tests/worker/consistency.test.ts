import { describe, expect, it } from 'vitest'
import {
  assertJobConsistency,
  InconsistentOwnershipError,
} from '@/lib/worker/consistency'

const coerente = {
  postOwnerId: 'u1',
  accountOwnerId: 'u1',
  subredditOwnerId: 'u1',
  postAccountId: 'a1',
  subredditAccountId: 'a1',
}

describe('assertJobConsistency', () => {
  it('aceita job coerente', () => {
    expect(() => assertJobConsistency(coerente)).not.toThrow()
  })

  it('recusa owner divergente entre post e conta', () => {
    expect(() =>
      assertJobConsistency({ ...coerente, accountOwnerId: 'u2' }),
    ).toThrow(InconsistentOwnershipError)
  })

  it('recusa owner divergente entre post e comunidade', () => {
    expect(() =>
      assertJobConsistency({ ...coerente, subredditOwnerId: 'u2' }),
    ).toThrow(InconsistentOwnershipError)
  })

  it('recusa comunidade que não é da conta do post', () => {
    // Mesmo dono, mas a comunidade foi sincronizada por outra conta: publicar
    // ali sairia pela conta errada.
    expect(() =>
      assertJobConsistency({ ...coerente, subredditAccountId: 'a2' }),
    ).toThrow(InconsistentOwnershipError)
  })

  it('a mensagem não vaza identificadores em claro', () => {
    try {
      assertJobConsistency({ ...coerente, accountOwnerId: 'u2' })
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).not.toContain('u1')
      expect((e as Error).message).not.toContain('u2')
    }
  })
})
