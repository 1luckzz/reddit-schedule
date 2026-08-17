import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import {
  AccountUnavailableError,
  loadAccountForWorker,
} from '@/lib/worker/load-account'

let userA: { id: string; accessToken: string }
let conta: string

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`la-${stamp}@teste.local`)

  const { data } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_la_${stamp}`,
      username: 'conta_worker',
    })
    .select('id')
    .single()
  conta = data!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('loadAccountForWorker', () => {
  it('carrega a conta conectada com o owner correto', async () => {
    const c = await loadAccountForWorker(adminClient(), conta)
    expect(c.id).toBe(conta)
    expect(c.owner_id).toBe(userA.id)
  })

  it('não traz nenhuma coluna sensível', async () => {
    // O worker precisa de identidade e cadência, não de segredos: estes vêm
    // separados, decifrados, por readAccountSecrets.
    const c = await loadAccountForWorker(adminClient(), conta)
    const chaves = Object.keys(c)
    for (const proibida of [
      'access_token_enc',
      'refresh_token_enc',
      'proxy_password_enc',
    ]) {
      expect(chaves).not.toContain(proibida)
    }
  })

  it('recusa conta inexistente', async () => {
    await expect(
      loadAccountForWorker(
        adminClient(),
        '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      ),
    ).rejects.toBeInstanceOf(AccountUnavailableError)
  })

  it('recusa conta desconectada', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', conta)

    await expect(
      loadAccountForWorker(adminClient(), conta),
    ).rejects.toBeInstanceOf(AccountUnavailableError)

    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'connected' })
      .eq('id', conta)
  })

  it('a mensagem explica a situação sem jargão', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'revoked' })
      .eq('id', conta)

    try {
      await loadAccountForWorker(adminClient(), conta)
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).toMatch(/não está disponível/i)
    } finally {
      await adminClient()
        .from('reddit_accounts')
        .update({ status: 'connected' })
        .eq('id', conta)
    }
  })
})
