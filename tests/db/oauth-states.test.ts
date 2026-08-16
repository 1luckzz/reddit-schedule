import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }

const hash = (v: string) => createHash('sha256').update(v).digest('hex')

async function insertState(ownerId: string, value: string, ttlMs = 600_000) {
  const { error } = await adminClient().from('oauth_states').insert({
    owner_id: ownerId,
    state_hash: hash(value),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  })
  if (error) throw error
}

/** Mesmo UPDATE condicional que o callback usa. */
async function consume(value: string) {
  return adminClient()
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state_hash', hash(value))
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('owner_id')
}

beforeAll(async () => {
  userA = await createTestUser(`os-${Date.now()}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('oauth_states', () => {
  it('consome um state válido uma vez', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const { data } = await consume(value)
    expect(data).toHaveLength(1)
    expect(data![0].owner_id).toBe(userA.id)
  })

  it('recusa o mesmo state numa segunda tentativa (replay)', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const first = await consume(value)
    expect(first.data).toHaveLength(1)

    const second = await consume(value)
    expect(second.data).toHaveLength(0)
  })

  it('recusa state expirado', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value, -1000)
    const { data } = await consume(value)
    expect(data).toHaveLength(0)
  })

  it('recusa state inexistente', async () => {
    const { data } = await consume(randomBytes(32).toString('base64url'))
    expect(data).toHaveLength(0)
  })

  it('duas tentativas concorrentes: exatamente uma vence', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const [a, b] = await Promise.all([consume(value), consume(value)])
    const vencedores = [a.data?.length ?? 0, b.data?.length ?? 0]
    expect(vencedores.filter((n) => n === 1)).toHaveLength(1)
    expect(vencedores.filter((n) => n === 0)).toHaveLength(1)
  })

  it('não guarda o valor cru do state, apenas o hash', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const { data } = await adminClient()
      .from('oauth_states')
      .select('*')
      .eq('state_hash', hash(value))
      .single()
    expect(JSON.stringify(data)).not.toContain(value)
  })

  it('impede dois registros com o mesmo hash', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const { error } = await adminClient().from('oauth_states').insert({
      owner_id: userA.id,
      state_hash: hash(value),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    })
    expect(error).not.toBeNull()
  })

  it('o cliente não alcança a tabela pelo Data API', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('oauth_states')
      .select('state_hash')
    expect(data ?? []).toHaveLength(0)
  })

  it('apagar o usuário apaga os states em cascata', async () => {
    const temp = await createTestUser(`os-tmp-${Date.now()}@teste.local`)
    const value = randomBytes(32).toString('base64url')
    await insertState(temp.id, value)
    await cleanupTestUsers([temp.id])
    const { data } = await adminClient()
      .from('oauth_states')
      .select('id')
      .eq('state_hash', hash(value))
    expect(data).toHaveLength(0)
  })
})
