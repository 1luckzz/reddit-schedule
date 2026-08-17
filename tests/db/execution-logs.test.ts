import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient,
  cleanupTestUsers,
  createTestUser,
  userClient,
} from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`el-a-${stamp}@teste.local`)
  userB = await createTestUser(`el-b-${stamp}@teste.local`)

  await adminClient().from('execution_logs').insert({
    owner_id: userA.id,
    action: 'submit_post',
    outcome: 'success',
    http_status: 200,
    duration_ms: 350,
  })
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('execution_logs', () => {
  it('o usuário lê apenas os próprios registros', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('execution_logs')
      .select('id')
    expect((data ?? []).length).toBeGreaterThan(0)
  })

  it('o usuário B não enxerga registros de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('execution_logs')
      .select('id')
    expect(data).toHaveLength(0)
  })

  it('authenticated tem apenas SELECT', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select distinct privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_name = 'execution_logs'
         order by privilege_type`,
      ),
    )
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
  })

  it('o usuário não insere registros: quem escreve é o worker', async () => {
    // Um log forjável não serviria para diagnóstico nenhum.
    const { error } = await userClient(userA.accessToken)
      .from('execution_logs')
      .insert({ owner_id: userA.id, action: 'forjado', outcome: 'success' })
    expect(error).not.toBeNull()
  })

  it('o usuário não apaga registros para esconder o histórico', async () => {
    const { data: antes } = await adminClient()
      .from('execution_logs')
      .select('id')
      .eq('owner_id', userA.id)

    await userClient(userA.accessToken)
      .from('execution_logs')
      .delete()
      .eq('owner_id', userA.id)

    const { data: depois } = await adminClient()
      .from('execution_logs')
      .select('id')
      .eq('owner_id', userA.id)
    expect(depois).toHaveLength((antes ?? []).length)
  })

  it('recusa outcome fora da lista', async () => {
    const { error } = await adminClient().from('execution_logs').insert({
      owner_id: userA.id,
      action: 'submit_post',
      outcome: 'inventado',
    })
    expect(error).not.toBeNull()
  })

  it('aceita os quatro desfechos previstos', async () => {
    for (const outcome of ['success', 'failure', 'retry', 'unknown']) {
      const { error } = await adminClient().from('execution_logs').insert({
        owner_id: userA.id,
        action: 'submit_post',
        outcome,
      })
      expect(error).toBeNull()
    }
  })

  it('apagar o usuário apaga os logs em cascata', async () => {
    const temp = await createTestUser(`el-t-${Date.now()}@teste.local`)
    await adminClient().from('execution_logs').insert({
      owner_id: temp.id,
      action: 'submit_post',
      outcome: 'failure',
    })
    await cleanupTestUsers([temp.id])

    const { data } = await adminClient()
      .from('execution_logs')
      .select('id')
      .eq('owner_id', temp.id)
    expect(data).toHaveLength(0)
  })
})
