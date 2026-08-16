import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaB: string

// Sessão e client são injetados: quem está sob teste é assertAccountAccess,
// não o Next.
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
  const stamp = Date.now()
  userA = await createTestUser(`or-a-${stamp}@teste.local`)
  userB = await createTestUser(`or-b-${stamp}@teste.local`)

  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userB.id,
      reddit_user_id: `t2_or_${stamp}`,
      username: 'conta_do_b',
    })
    .select('id')
    .single()
  if (error) throw error
  contaB = data.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('assertAccountAccess em runtime', () => {
  it('recusa quando o usuário A pede a conta de B', async () => {
    sessao.id = userA.id
    clientToken.value = userA.accessToken

    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )
    await expect(assertAccountAccess(contaB)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('recusa mesmo se a RLS devolvesse a linha (defesa independente)', async () => {
    // A sessão diz que é A, mas o client enxerga como B: simula uma policy
    // afrouxada por engano. A comparação explícita de owner_id precisa barrar.
    sessao.id = userA.id
    clientToken.value = userB.accessToken

    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )
    await expect(assertAccountAccess(contaB)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('aceita quando sessão e posse coincidem', async () => {
    sessao.id = userB.id
    clientToken.value = userB.accessToken

    const { assertAccountAccess } = await import('@/lib/auth/ownership')
    const conta = await assertAccountAccess(contaB)
    expect(conta.id).toBe(contaB)
    expect(conta.owner_id).toBe(userB.id)
  })

  it('recusa id inexistente', async () => {
    sessao.id = userB.id
    clientToken.value = userB.accessToken

    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )
    await expect(
      assertAccountAccess('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})
