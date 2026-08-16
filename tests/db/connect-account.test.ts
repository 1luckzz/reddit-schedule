import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { AccountTakenError, connectAccount } from '@/lib/reddit/connect-account'

let userA: { id: string; accessToken: string }

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  userA = await createTestUser(`ca-${Date.now()}@teste.local`)
})

beforeEach(() => {
  // A chave precisa ser estável entre gravação e leitura dentro do teste.
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64')
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

const token = {
  access_token: 'AT-1',
  refresh_token: 'RT-1',
  expires_in: 3600,
  scope: 'identity submit mysubreddits',
  token_type: 'bearer',
}

describe('connectAccount', () => {
  it('cria a conta e guarda os segredos cifrados', async () => {
    const id = await connectAccount(userA.id, token, {
      id: `t2_abc_${Date.now()}`,
      name: 'conta01',
    })

    const conta = await adminClient()
      .from('reddit_accounts')
      .select('username, status, scopes, last_authenticated_at')
      .eq('id', id)
      .single()
    expect(conta.data!.username).toBe('conta01')
    expect(conta.data!.status).toBe('connected')
    expect(conta.data!.scopes).toContain('submit')
    expect(conta.data!.last_authenticated_at).not.toBeNull()

    const segredo = await adminClient()
      .from('reddit_account_secrets')
      .select('access_token_enc, refresh_token_enc')
      .eq('reddit_account_id', id)
      .single()

    const { decryptSecret } = await import('@/lib/crypto/aes-gcm')

    // Difere do claro, não contém o claro, e volta ao claro no servidor.
    expect(segredo.data!.access_token_enc).not.toBe('AT-1')
    expect(segredo.data!.access_token_enc).not.toContain('AT-1')
    expect(segredo.data!.refresh_token_enc).not.toContain('RT-1')
    expect(
      decryptSecret(
        segredo.data!.access_token_enc,
        `reddit_account_secrets:access_token:${id}`,
      ),
    ).toBe('AT-1')
    expect(
      decryptSecret(
        segredo.data!.refresh_token_enc,
        `reddit_account_secrets:refresh_token:${id}`,
      ),
    ).toBe('RT-1')
  })

  it('reconectar a mesma conta atualiza em vez de duplicar', async () => {
    const redditId = `t2_repetida_${Date.now()}`
    const primeiro = await connectAccount(userA.id, token, {
      id: redditId,
      name: 'conta02',
    })
    const segundo = await connectAccount(
      userA.id,
      { ...token, access_token: 'AT-2' },
      { id: redditId, name: 'conta02_renomeada' },
    )
    expect(segundo).toBe(primeiro)

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('id, username')
      .eq('owner_id', userA.id)
      .eq('reddit_user_id', redditId)
    expect(data).toHaveLength(1)
    expect(data![0].username).toBe('conta02_renomeada')
  })

  it('reconectar limpa o status e o erro anterior', async () => {
    const redditId = `t2_erro_${Date.now()}`
    const id = await connectAccount(userA.id, token, {
      id: redditId,
      name: 'conta03',
    })
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected', last_error: 'REFRESH_INVALID' })
      .eq('id', id)

    await connectAccount(userA.id, token, { id: redditId, name: 'conta03' })

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('status, last_error')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('connected')
    expect(data!.last_error).toBeNull()
  })

  it('recusa conectar identidade Reddit já usada por outro usuário do painel', async () => {
    const outro = await createTestUser(`ca-outro-${Date.now()}@teste.local`)
    const redditId = `t2_disputada_${Date.now()}`
    try {
      await connectAccount(userA.id, token, { id: redditId, name: 'x' })
      await expect(
        connectAccount(outro.id, token, { id: redditId, name: 'x' }),
      ).rejects.toBeInstanceOf(AccountTakenError)

      // E a conta continua com o dono original.
      const { data } = await adminClient()
        .from('reddit_accounts')
        .select('owner_id')
        .eq('reddit_user_id', redditId)
        .single()
      expect(data!.owner_id).toBe(userA.id)
    } finally {
      await cleanupTestUsers([outro.id])
    }
  })

  it('a mensagem de conta em uso não revela quem a conectou', () => {
    const erro = new AccountTakenError()
    expect(erro.message).not.toContain('@')
    expect(erro.message).toMatch(/outro usuário/i)
  })

  it('os escopos vêm da resposta do Reddit, não de uma lista fixa', async () => {
    const id = await connectAccount(
      userA.id,
      { ...token, scope: 'identity read' },
      { id: `t2_escopos_${Date.now()}`, name: 'conta04' },
    )
    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('scopes')
      .eq('id', id)
      .single()
    expect(data!.scopes).toEqual(['identity', 'read'])
  })

  it('a expiração é calculada a partir de expires_in', async () => {
    const antes = Date.now()
    const id = await connectAccount(
      userA.id,
      { ...token, expires_in: 3600 },
      { id: `t2_exp_${Date.now()}`, name: 'conta05' },
    )

    const { data } = await adminClient()
      .from('reddit_account_secrets')
      .select('access_token_expires_at')
      .eq('reddit_account_id', id)
      .single()

    const expira = new Date(data!.access_token_expires_at).getTime()
    expect(expira).toBeGreaterThanOrEqual(antes + 3500_000)
    expect(expira).toBeLessThanOrEqual(Date.now() + 3700_000)
  })
})
