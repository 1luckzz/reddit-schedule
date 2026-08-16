import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupTestUsers, createTestUser } from './helpers'
import {
  consumeOAuthState,
  createOAuthState,
  OAuthStateError,
} from '@/lib/reddit/auth'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`of-a-${stamp}@teste.local`)
  userB = await createTestUser(`of-b-${stamp}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('state do OAuth', () => {
  it('gera valor com entropia de 32 bytes', async () => {
    const { value } = await createOAuthState(userA.id)
    expect(Buffer.from(value, 'base64url')).toHaveLength(32)
  })

  it('o cookie é httpOnly, SameSite=Lax e de vida curta', async () => {
    const { cookie } = await createOAuthState(userA.id)
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('lax')
    expect(cookie.maxAge).toBeLessThanOrEqual(600)
    expect(cookie.path).toBe('/api/reddit')
  })

  it('dois states seguidos nunca coincidem', async () => {
    const a = await createOAuthState(userA.id)
    const b = await createOAuthState(userA.id)
    expect(a.value).not.toBe(b.value)
  })

  it('consome um state válido do próprio usuário', async () => {
    const { value } = await createOAuthState(userA.id)
    await expect(consumeOAuthState(value, userA.id)).resolves.toBeUndefined()
  })

  it('recusa replay do mesmo state', async () => {
    const { value } = await createOAuthState(userA.id)
    await consumeOAuthState(value, userA.id)
    await expect(consumeOAuthState(value, userA.id)).rejects.toBeInstanceOf(
      OAuthStateError,
    )
  })

  it('recusa state pertencente a outra sessão', async () => {
    const { value } = await createOAuthState(userA.id)
    await expect(consumeOAuthState(value, userB.id)).rejects.toBeInstanceOf(
      OAuthStateError,
    )
  })

  it('recusa state inexistente', async () => {
    await expect(
      consumeOAuthState('state-que-nunca-existiu', userA.id),
    ).rejects.toBeInstanceOf(OAuthStateError)
  })

  it('um state recusado por owner errado não pode ser reusado pelo dono', async () => {
    const { value } = await createOAuthState(userA.id)
    await expect(consumeOAuthState(value, userB.id)).rejects.toThrow()
    // A tentativa falha sem consumir: o dono legítimo ainda consegue usar.
    await expect(consumeOAuthState(value, userA.id)).resolves.toBeUndefined()
  })

  it('a mensagem de erro é a mesma para todos os motivos', async () => {
    // Não informa a quem tenta adivinhar se o state existia, expirou ou era
    // de outra sessão.
    const inexistente = await consumeOAuthState('nao-existe', userA.id).catch(
      (e) => e as Error,
    )
    const { value } = await createOAuthState(userA.id)
    const outraSessao = await consumeOAuthState(value, userB.id).catch(
      (e) => e as Error,
    )
    expect(inexistente.message).toBe(outraSessao.message)
  })
})
