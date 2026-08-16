import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`a-${stamp}@teste.local`)
  userB = await createTestUser(`b-${stamp}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('profiles', () => {
  it('cria o profile automaticamente no signup', async () => {
    const { data, error } = await adminClient()
      .from('profiles')
      .select('id, timezone, log_retention_days')
      .eq('id', userA.id)
      .single()
    expect(error).toBeNull()
    expect(data!.timezone).toBe('America/Sao_Paulo')
    expect(data!.log_retention_days).toBe(30)
  })

  it('o usuário lê o próprio profile', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('profiles')
      .select('id')
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(userA.id)
  })

  it('o usuário A não enxerga o profile do usuário B', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('profiles')
      .select('id')
      .eq('id', userB.id)
    expect(data).toHaveLength(0)
  })

  it('o usuário atualiza o próprio timezone', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('profiles')
      .update({ timezone: 'UTC' })
      .eq('id', userA.id)
    expect(error).toBeNull()
  })

  it('o usuário A não atualiza o profile do usuário B', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('profiles')
      .update({ timezone: 'UTC' })
      .eq('id', userB.id)
      .select()
    expect(data).toHaveLength(0)

    const check = await adminClient()
      .from('profiles')
      .select('timezone')
      .eq('id', userB.id)
      .single()
    expect(check.data!.timezone).toBe('America/Sao_Paulo')
  })

  it('o usuário não consegue inserir profile para outro id', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('profiles')
      .insert({ id: userB.id })
    expect(error).not.toBeNull()
  })

  it('rejeita log_retention_days fora da faixa permitida', async () => {
    const { error } = await adminClient()
      .from('profiles')
      .update({ log_retention_days: 0 })
      .eq('id', userA.id)
    expect(error).not.toBeNull()
  })

  it('updated_at avança a cada update', async () => {
    const admin = adminClient()
    const before = await admin
      .from('profiles')
      .select('updated_at')
      .eq('id', userB.id)
      .single()
    await new Promise((r) => setTimeout(r, 1100))
    await admin.from('profiles').update({ log_retention_days: 45 }).eq('id', userB.id)
    const after = await admin
      .from('profiles')
      .select('updated_at')
      .eq('id', userB.id)
      .single()
    expect(new Date(after.data!.updated_at).getTime()).toBeGreaterThan(
      new Date(before.data!.updated_at).getTime(),
    )
  })

  it('apagar o usuário apaga o profile em cascata', async () => {
    const temp = await createTestUser(`c-${Date.now()}@teste.local`)
    await cleanupTestUsers([temp.id])
    const { data } = await adminClient()
      .from('profiles')
      .select('id')
      .eq('id', temp.id)
    expect(data).toHaveLength(0)
  })
})
