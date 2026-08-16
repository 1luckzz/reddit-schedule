import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { readRateLimit } from '@/lib/reddit/ratelimit'
import { RedditError } from '@/lib/reddit/errors'

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

function pool() {
  return agent.get('https://oauth.reddit.com')
}

/** O client acrescenta raw_json=1, então o match é pelo início do path. */
const path = (p: string) => (actual: string) => actual.startsWith(p)

describe('createRedditClient', () => {
  it('envia Authorization e User-Agent obrigatórios', async () => {
    let capturados: Record<string, unknown> = {}
    pool()
      .intercept({ path: path('/api/v1/me'), method: 'GET' })
      .reply(200, (opts) => {
        capturados = opts.headers as Record<string, unknown>
        return { id: 't2_1', name: 'conta01' }
      })

    const client = createRedditClient({ accessToken: 'AT-123', dispatcher: agent })
    await client.request({ path: '/api/v1/me' })

    expect(capturados['authorization']).toBe('bearer AT-123')
    expect(String(capturados['user-agent'])).toContain('reddit-scheduler')
  })

  it('devolve o corpo já convertido', async () => {
    pool()
      .intercept({ path: path('/api/v1/me'), method: 'GET' })
      .reply(200, { id: 't2_1', name: 'conta01' })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    const { data } = await client.request<{ name: string }>({ path: '/api/v1/me' })
    expect(data.name).toBe('conta01')
  })

  it('serializa form como application/x-www-form-urlencoded', async () => {
    let corpo = ''
    pool()
      .intercept({ path: path('/api/submit'), method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return { json: { errors: [] } }
      })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await client.request({
      path: '/api/submit',
      method: 'POST',
      form: { kind: 'link', title: 'Olá mundo', sr: 'teste' },
      hasSideEffect: true,
    })

    expect(corpo).toContain('kind=link')
    expect(corpo).toContain('title=Ol%C3%A1+mundo')
    expect(corpo).toContain('api_type=json')
  })

  it('lê os headers de rate limit', async () => {
    pool()
      .intercept({ path: path('/api/v1/me'), method: 'GET' })
      .reply(200, { id: 't2_1' }, {
        headers: {
          'x-ratelimit-used': '12',
          'x-ratelimit-remaining': '88',
          'x-ratelimit-reset': '340',
        },
      })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    const { rateLimit } = await client.request({ path: '/api/v1/me' })
    expect(rateLimit).toEqual({ used: 12, remaining: 88, resetSeconds: 340 })
  })

  it('converte 429 em RedditError retryable com Retry-After', async () => {
    pool()
      .intercept({ path: path('/api/v1/me'), method: 'GET' })
      .reply(429, {}, { headers: { 'retry-after': '17' } })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      disposition: 'retryable',
      retryAfterSeconds: 17,
    })
  })

  it('5xx em requisição de efeito vira unknown', async () => {
    pool().intercept({ path: path('/api/submit'), method: 'POST' }).reply(503, {})

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(
      client.request({
        path: '/api/submit',
        method: 'POST',
        form: { kind: 'self' },
        hasSideEffect: true,
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'unknown' })
  })

  it('5xx em leitura vira retryable', async () => {
    pool().intercept({ path: path('/api/v1/me'), method: 'GET' }).reply(503, {})

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      disposition: 'retryable',
    })
  })

  it('200 com json.errors vira erro terminal', async () => {
    pool()
      .intercept({ path: path('/api/submit'), method: 'POST' })
      .reply(200, { json: { errors: [['SUBREDDIT_NOTALLOWED', 'não permitido']] } })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(
      client.request({
        path: '/api/submit',
        method: 'POST',
        form: {},
        hasSideEffect: true,
      }),
    ).rejects.toMatchObject({ disposition: 'terminal' })
  })

  it('erro do cliente nunca carrega o token', async () => {
    pool().intercept({ path: path('/api/v1/me'), method: 'GET' }).reply(403, {})

    const client = createRedditClient({
      accessToken: 'AT-SUPER-SECRETO',
      dispatcher: agent,
    })
    try {
      await client.request({ path: '/api/v1/me' })
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect(e).toBeInstanceOf(RedditError)
      expect(JSON.stringify(e)).not.toContain('AT-SUPER-SECRETO')
      expect((e as Error).stack ?? '').not.toContain('AT-SUPER-SECRETO')
      expect((e as Error).message).not.toContain('AT-SUPER-SECRETO')
    }
  })

  it('monta a query string a partir de query', async () => {
    let recebido = ''
    pool()
      .intercept({ path: path('/subreddits/mine/moderator'), method: 'GET' })
      .reply(200, (opts) => {
        recebido = String(opts.path)
        return { data: { children: [] } }
      })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await client.request({
      path: '/subreddits/mine/moderator',
      query: { limit: '100' },
    })
    expect(recebido).toContain('limit=100')
    expect(recebido).toContain('raw_json=1')
  })

  it('corpo ilegível em requisição de efeito vira unknown', async () => {
    pool()
      .intercept({ path: path('/api/submit'), method: 'POST' })
      .reply(200, 'isto nao e json')

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(
      client.request({
        path: '/api/submit',
        method: 'POST',
        form: {},
        hasSideEffect: true,
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'unknown' })
  })

  it('falha de rede em leitura é retryable', async () => {
    pool()
      .intercept({ path: path('/api/v1/me'), method: 'GET' })
      .replyWithError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      disposition: 'retryable',
    })
  })

  it('falha de rede em requisição de efeito vira unknown', async () => {
    pool()
      .intercept({ path: path('/api/submit'), method: 'POST' })
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(
      client.request({
        path: '/api/submit',
        method: 'POST',
        form: {},
        hasSideEffect: true,
      }),
    ).rejects.toMatchObject({ disposition: 'unknown' })
  })
})

describe('readRateLimit', () => {
  it('devolve nulos quando os headers não vêm', () => {
    expect(readRateLimit({})).toEqual({
      used: null,
      remaining: null,
      resetSeconds: null,
    })
  })

  it('ignora valores não numéricos', () => {
    expect(readRateLimit({ 'x-ratelimit-remaining': 'abc' }).remaining).toBeNull()
  })

  it('aceita valores fracionários que o Reddit às vezes envia', () => {
    expect(readRateLimit({ 'x-ratelimit-remaining': '95.0' }).remaining).toBe(95)
  })
})
