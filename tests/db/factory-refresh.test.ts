import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { encryptSecret } from '@/lib/crypto/aes-gcm'

let userA: { id: string; accessToken: string }
let agent: MockAgent

async function seedAccount(expiresInMs: number) {
  const sufixo = randomBytes(6).toString('hex')
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_${sufixo}`,
      username: `conta_${sufixo}`,
      scopes: ['identity', 'submit'],
    })
    .select('id')
    .single()
  if (error) throw error

  const id = data.id as string
  const seed = await adminClient().from('reddit_account_secrets').insert({
    reddit_account_id: id,
    owner_id: userA.id,
    access_token_enc: encryptSecret(
      'AT-ANTIGO',
      `reddit_account_secrets:access_token:${id}`,
    ),
    refresh_token_enc: encryptSecret(
      'RT-1',
      `reddit_account_secrets:refresh_token:${id}`,
    ),
    access_token_expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  })
  if (seed.error) throw seed.error
  return id
}

function conta(id: string) {
  return { id, owner_id: userA.id } as never
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  userA = await createTestUser(`fr-${Date.now()}@teste.local`)
})

beforeEach(() => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('refresh automático', () => {
  it('não renova quando o token ainda tem folga', async () => {
    const id = await seedAccount(3600_000)
    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    // Nenhum intercept registrado: qualquer chamada de rede falharia o teste.
    await getRedditClient(conta(id), {
      dispatcher: agent,
      skipOwnershipCheck: true,
    })
    expect(agent.pendingInterceptors()).toHaveLength(0)
  })

  it('renova quando faltam menos de 120s e persiste o token novo cifrado', async () => {
    const id = await seedAccount(60_000)
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT-NOVO',
        expires_in: 3600,
        scope: 'identity',
        token_type: 'bearer',
      })

    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    await getRedditClient(conta(id), {
      dispatcher: agent,
      skipOwnershipCheck: true,
    })

    const { data } = await adminClient()
      .from('reddit_account_secrets')
      .select('access_token_enc')
      .eq('reddit_account_id', id)
      .single()

    const armazenado = data!.access_token_enc

    // O prefixo v1. diz apenas qual é o formato do envelope — sozinho ele não
    // prova cifragem nenhuma. As três verificações abaixo é que provam:
    // 1. o valor armazenado difere do texto claro;
    expect(armazenado).not.toBe('AT-NOVO')
    // 2. o texto claro não aparece em lugar nenhum do valor armazenado,
    //    nem em base64, nem em hex;
    expect(armazenado).not.toContain('AT-NOVO')
    expect(armazenado).not.toContain(Buffer.from('AT-NOVO').toString('base64'))
    expect(armazenado).not.toContain(
      Buffer.from('AT-NOVO').toString('base64url'),
    )
    expect(armazenado).not.toContain(Buffer.from('AT-NOVO').toString('hex'))
    // 3. e o decrypt no servidor recupera exatamente o valor original.
    const { decryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(
      decryptSecret(armazenado, `reddit_account_secrets:access_token:${id}`),
    ).toBe('AT-NOVO')
  })

  it('o refresh token guardado também é recuperável e nunca fica em claro', async () => {
    const id = await seedAccount(3600_000)

    const { data } = await adminClient()
      .from('reddit_account_secrets')
      .select('refresh_token_enc')
      .eq('reddit_account_id', id)
      .single()

    const armazenado = data!.refresh_token_enc
    expect(armazenado).not.toBe('RT-1')
    expect(armazenado).not.toContain('RT-1')

    const { decryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(
      decryptSecret(armazenado, `reddit_account_secrets:refresh_token:${id}`),
    ).toBe('RT-1')
  })

  it('o mesmo valor cifrado duas vezes produz registros diferentes', async () => {
    // Se dois tokens iguais gerassem o mesmo ciphertext, um observador do
    // banco saberia que duas contas compartilham credencial.
    const a = await seedAccount(3600_000)
    const b = await seedAccount(3600_000)

    const leitura = await adminClient()
      .from('reddit_account_secrets')
      .select('reddit_account_id, refresh_token_enc')
      .in('reddit_account_id', [a, b])

    const [um, dois] = leitura.data!
    expect(um.refresh_token_enc).not.toBe(dois.refresh_token_enc)
  })

  it('refresh inválido marca a conta como disconnected', async () => {
    const id = await seedAccount(1000)
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(400, { error: 'invalid_grant' })

    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    await expect(
      getRedditClient(conta(id), { dispatcher: agent, skipOwnershipCheck: true }),
    ).rejects.toMatchObject({ code: 'REFRESH_INVALID' })

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('status, last_error')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('disconnected')
    expect(data!.last_error).toBe('REFRESH_INVALID')
    expect(data!.last_error).not.toContain('RT-1')
  })

  it('o lock impede dois refreshes simultâneos da mesma conta', async () => {
    const id = await seedAccount(60_000)
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT-UNICO',
        expires_in: 3600,
        scope: 'identity',
        token_type: 'bearer',
      })
      .times(1)

    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    const chamada = () =>
      getRedditClient(conta(id), { dispatcher: agent, skipOwnershipCheck: true })

    // Se ambos renovassem, o segundo não encontraria intercept e falharia.
    const resultados = await Promise.allSettled([chamada(), chamada()])
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
  })
})
