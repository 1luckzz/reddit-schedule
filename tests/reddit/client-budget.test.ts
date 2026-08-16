import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'

let agent: MockAgent

beforeEach(() => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
})

afterEach(async () => {
  await agent.close()
})

const me = (p: string) => p.startsWith('/api/v1/me')
const pool = () => agent.get('https://oauth.reddit.com')

describe('client e orçamento', () => {
  it('reserva antes de emitir a requisição', async () => {
    const ordem: string[] = []
    const onBeforeRequest = vi.fn(async () => {
      ordem.push('reserva')
    })

    pool()
      .intercept({ path: me, method: 'GET' })
      .reply(200, () => {
        ordem.push('requisicao')
        return { id: 't2_1' }
      })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest,
    })
    await client.request({ path: '/api/v1/me' })

    expect(ordem).toEqual(['reserva', 'requisicao'])
  })

  it('reserva negada impede a requisição e propaga o erro', async () => {
    const onBeforeRequest = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('sem orçamento'), { code: 'BUDGET_EXHAUSTED' }),
      )

    // Nenhum intercept: se a requisição saísse, o teste falharia.
    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest,
    })

    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    })
  })

  it('reconcilia com o snapshot da resposta', async () => {
    const onAfterRequest = vi.fn()
    pool()
      .intercept({ path: me, method: 'GET' })
      .reply(200, { id: 't2_1' }, {
        headers: {
          'x-ratelimit-used': '5',
          'x-ratelimit-remaining': '95',
          'x-ratelimit-reset': '200',
        },
      })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await client.request({ path: '/api/v1/me' })

    expect(onAfterRequest).toHaveBeenCalledWith({
      used: 5,
      remaining: 95,
      resetSeconds: 200,
    })
  })

  it('também reconcilia quando a resposta é erro', async () => {
    const onAfterRequest = vi.fn()
    pool()
      .intercept({ path: me, method: 'GET' })
      .reply(429, {}, {
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
      })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toBeTruthy()
    expect(onAfterRequest).toHaveBeenCalled()
  })

  it('libera a reserva com null quando não há resposta', async () => {
    const onAfterRequest = vi.fn()
    pool()
      .intercept({ path: me, method: 'GET' })
      .replyWithError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toBeTruthy()

    // null significa "sem informação": libera a reserva sem mexer nos números.
    expect(onAfterRequest).toHaveBeenCalledWith(null)
  })

  it('toda reserva aceita tem exatamente uma devolução', async () => {
    const eventos: string[] = []
    const onBeforeRequest = vi.fn(async () => {
      eventos.push('reserva')
    })
    const onAfterRequest = vi.fn(async () => {
      eventos.push('devolucao')
    })

    pool().intercept({ path: me, method: 'GET' }).reply(200, { id: 't2_1' })
    pool().intercept({ path: me, method: 'GET' }).reply(403, {})
    pool()
      .intercept({ path: me, method: 'GET' })
      .replyWithError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest,
      onAfterRequest,
    })

    await client.request({ path: '/api/v1/me' }).catch(() => {})
    await client.request({ path: '/api/v1/me' }).catch(() => {})
    await client.request({ path: '/api/v1/me' }).catch(() => {})

    expect(eventos.filter((e) => e === 'reserva')).toHaveLength(3)
    expect(eventos.filter((e) => e === 'devolucao')).toHaveLength(3)
  })

  it('falha da reconciliação não derruba a requisição', async () => {
    // Reconciliar é telemetria: não pode custar a operação do usuário.
    const onAfterRequest = vi.fn().mockRejectedValue(new Error('banco fora'))
    pool().intercept({ path: me, method: 'GET' }).reply(200, { id: 't2_1' })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await expect(client.request({ path: '/api/v1/me' })).resolves.toBeTruthy()
  })

  it('sem callbacks, o cliente funciona normalmente', async () => {
    pool().intercept({ path: me, method: 'GET' }).reply(200, { id: 't2_1' })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(client.request({ path: '/api/v1/me' })).resolves.toBeTruthy()
  })
})
