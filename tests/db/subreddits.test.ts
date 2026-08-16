import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string

async function criarConta(ownerId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_sub_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function criarSubreddit(ownerId: string, contaId: string, nome: string) {
  const { data, error } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_${nome}`,
      name: nome,
      display_name: `Comunidade ${nome}`,
      url: `/r/${nome}/`,
      submission_type: 'any',
      link_flair_enabled: true,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`sr-a-${stamp}@teste.local`)
  userB = await createTestUser(`sr-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaB = await criarConta(userB.id, `b${stamp}`)
  subA = await criarSubreddit(userA.id, contaA, `comunidade_a_${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('subreddits', () => {
  it('o usuário lê apenas as próprias comunidades', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('subreddits')
      .select('id')
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(subA)
  })

  it('o usuário B não enxerga as comunidades de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('subreddits')
      .select('id')
      .eq('id', subA)
    expect(data).toHaveLength(0)
  })

  it('o usuário não consegue inserir comunidades', async () => {
    // Comunidades vêm exclusivamente da sincronização com a API.
    const { error } = await userClient(userA.accessToken)
      .from('subreddits')
      .insert({
        owner_id: userA.id,
        reddit_account_id: contaA,
        subreddit_fullname: 't5_forjada',
        name: 'forjada',
        display_name: 'Forjada',
        url: '/r/forjada/',
      })
    expect(error).not.toBeNull()
  })

  it('o usuário não consegue alterar nem apagar comunidades', async () => {
    const update = await userClient(userA.accessToken)
      .from('subreddits')
      .update({ name: 'renomeada' })
      .eq('id', subA)
    expect(update.error).not.toBeNull()

    const del = await userClient(userA.accessToken)
      .from('subreddits')
      .delete()
      .eq('id', subA)
    expect(del.error).not.toBeNull()

    const check = await adminClient()
      .from('subreddits')
      .select('name')
      .eq('id', subA)
      .single()
    expect(check.data!.name).not.toBe('renomeada')
  })

  it('impede a mesma comunidade duas vezes para a mesma conta', async () => {
    const nome = `dup_${Date.now()}`
    await criarSubreddit(userA.id, contaA, nome)
    await expect(criarSubreddit(userA.id, contaA, nome)).rejects.toBeTruthy()
  })

  it('permite a mesma comunidade em contas diferentes', async () => {
    // Duas contas do mesmo usuário podem moderar a mesma comunidade.
    const outraConta = await criarConta(userA.id, `outra${Date.now()}`)
    const nome = `compartilhada_${Date.now()}`
    await expect(criarSubreddit(userA.id, contaA, nome)).resolves.toBeTruthy()
    await expect(criarSubreddit(userA.id, outraConta, nome)).resolves.toBeTruthy()
  })

  it('rejeita comunidade cujo owner_id diverge do dono da conta', async () => {
    const { error } = await adminClient().from('subreddits').insert({
      owner_id: userA.id, // owner errado de propósito
      reddit_account_id: contaB,
      subreddit_fullname: 't5_invalida',
      name: 'invalida',
      display_name: 'Inválida',
      url: '/r/invalida/',
    })
    expect(error).not.toBeNull()
  })

  it('rejeita submission_type fora da lista da API', async () => {
    const { error } = await adminClient()
      .from('subreddits')
      .update({ submission_type: 'inventado' })
      .eq('id', subA)
    expect(error).not.toBeNull()
  })

  it('rejeita status fora da lista permitida', async () => {
    const { error } = await adminClient()
      .from('subreddits')
      .update({ status: 'inventado' })
      .eq('id', subA)
    expect(error).not.toBeNull()
  })

  it('apagar a conta apaga as comunidades em cascata', async () => {
    const conta = await criarConta(userA.id, `casc${Date.now()}`)
    const sub = await criarSubreddit(userA.id, conta, `casc_${Date.now()}`)
    await adminClient().from('reddit_accounts').delete().eq('id', conta)

    const { data } = await adminClient()
      .from('subreddits')
      .select('id')
      .eq('id', sub)
    expect(data).toHaveLength(0)
  })

  it('authenticated tem apenas SELECT sobre subreddits', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_name = 'subreddits'
         order by privilege_type`,
      ),
    )
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
  })
})
