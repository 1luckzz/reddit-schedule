import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { MockAgent } from 'undici'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { encryptSecret } from '@/lib/crypto/aes-gcm'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaB: string
let subB: string

const sessao = { id: '' }
const clientToken = { value: '' }

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: async () => ({ id: sessao.id, email: 'x@teste.local' }),
  UnauthenticatedError: class extends Error {},
}))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () =>
    createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${clientToken.value}` } },
      },
    ),
}))

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  process.env.REDDIT_CLIENT_ID = 'cid-suite-isolation'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'

  const stamp = Date.now()
  userA = await createTestUser(`ci-a-${stamp}@teste.local`)
  userB = await createTestUser(`ci-b-${stamp}@teste.local`)

  const { data: conta } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userB.id,
      reddit_user_id: `t2_ci_${stamp}`,
      username: 'conta_do_b',
    })
    .select('id')
    .single()
  contaB = conta!.id as string

  await adminClient().from('reddit_account_secrets').insert({
    reddit_account_id: contaB,
    owner_id: userB.id,
    access_token_enc: encryptSecret(
      'AT',
      `reddit_account_secrets:access_token:${contaB}`,
    ),
    refresh_token_enc: encryptSecret(
      'RT',
      `reddit_account_secrets:refresh_token:${contaB}`,
    ),
    access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })

  const { data: sub } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: userB.id,
      reddit_account_id: contaB,
      subreddit_fullname: `t5_ci_${stamp}`,
      name: 'comunidade_do_b',
      display_name: 'Comunidade do B',
      url: '/r/comunidade_do_b/',
    })
    .select('id')
    .single()
  subB = sub!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('isolamento das comunidades entre usuários', () => {
  it('A não lê as comunidades de B pelo Data API', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('subreddits')
      .select('id')
      .eq('id', subB)
    expect(data).toHaveLength(0)
  })

  it('A não sincroniza usando a conta de B', async () => {
    sessao.id = userA.id
    clientToken.value = userA.accessToken

    const agent = new MockAgent()
    agent.disableNetConnect()
    // Nenhum intercept: se a checagem de posse falhasse e a sincronização
    // seguisse, a chamada de rede quebraria o teste de forma barulhenta.

    const { syncCommunitiesFor } = await import('@/lib/reddit/sync-communities')
    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )

    await expect(assertAccountAccess(contaB)).rejects.toBeInstanceOf(
      ForbiddenError,
    )

    // E a via direta também barra, porque a action sempre passa por assert.
    await expect(
      (async () => {
        const conta = await assertAccountAccess(contaB)
        return syncCommunitiesFor(conta, { dispatcher: agent })
      })(),
    ).rejects.toBeInstanceOf(ForbiddenError)

    await agent.close()
  })

  it('a sincronização de B não cria comunidades no nome de A', async () => {
    const { data } = await adminClient()
      .from('subreddits')
      .select('owner_id')
      .eq('reddit_account_id', contaB)
    expect(data!.every((s) => s.owner_id === userB.id)).toBe(true)
  })

  it('o orçamento de rate limit não vaza para o cliente', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_api_budget')
      .select('remaining')
    expect(data ?? []).toHaveLength(0)
  })

  it('A não enxerga comunidades de B nem em consulta sem filtro', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('subreddits')
      .select('id, owner_id')
    expect((data ?? []).every((s) => s.owner_id === userA.id)).toBe(true)
  })
})
