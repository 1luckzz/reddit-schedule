import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { submitComment } from '@/lib/reddit/comments'

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

const pool = () => agent.get('https://oauth.reddit.com')
const commentPath = (p: string) => p.startsWith('/api/comment')
const client = () =>
  createRedditClient({ accessToken: 'AT', dispatcher: agent })

const sucesso = {
  json: {
    errors: [],
    data: {
      things: [
        {
          kind: 't1',
          data: {
            id: 'cmt1',
            name: 't1_cmt1',
            permalink: '/r/com/comments/abc/titulo/cmt1/',
          },
        },
      ],
    },
  },
}

describe('submitComment', () => {
  it('envia thing_id e text', async () => {
    let corpo = ''
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, (opts: { body?: unknown }) => {
        corpo = String(opts.body)
        return sucesso
      })

    await submitComment(client(), {
      thingId: 't3_abc123',
      body: 'meu comentário',
    })

    expect(corpo).toContain('thing_id=t3_abc123')
    expect(corpo).toContain('text=meu+coment')
  })

  it('devolve id, fullname e permalink', async () => {
    pool().intercept({ path: commentPath, method: 'POST' }).reply(200, sucesso)

    const r = await submitComment(client(), {
      thingId: 't3_abc123',
      body: 'texto',
    })
    expect(r).toEqual({
      redditCommentId: 'cmt1',
      redditFullname: 't1_cmt1',
      permalink: '/r/com/comments/abc/titulo/cmt1/',
    })
  })

  it('marca a requisição como tendo efeito colateral', async () => {
    pool().intercept({ path: commentPath, method: 'POST' }).reply(502, {})

    await expect(
      submitComment(client(), { thingId: 't3_abc', body: 'x' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'unknown' })
  })

  it('queda de conexão vira resultado desconhecido', async () => {
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

    await expect(
      submitComment(client(), { thingId: 't3_abc', body: 'x' }),
    ).rejects.toMatchObject({ disposition: 'unknown' })
  })

  it('200 com json.errors vira erro terminal', async () => {
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, { json: { errors: [['DELETED_LINK', 'post removido']] } })

    await expect(
      submitComment(client(), { thingId: 't3_abc', body: 'x' }),
    ).rejects.toMatchObject({ disposition: 'terminal' })
  })

  it('resposta sem things vira resultado desconhecido', async () => {
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, { json: { errors: [], data: { things: [] } } })

    await expect(
      submitComment(client(), { thingId: 't3_abc', body: 'x' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })

  it('permalink ausente não impede o sucesso', async () => {
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, {
        json: {
          errors: [],
          data: { things: [{ kind: 't1', data: { id: 'c1', name: 't1_c1' } }] },
        },
      })

    const r = await submitComment(client(), { thingId: 't3_abc', body: 'x' })
    expect(r.redditCommentId).toBe('c1')
    expect(r.permalink).toBeNull()
  })
})
