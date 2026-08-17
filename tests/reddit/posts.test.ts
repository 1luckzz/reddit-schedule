import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { submitPost } from '@/lib/reddit/posts'

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
const submitPath = (p: string) => p.startsWith('/api/submit')
const client = () =>
  createRedditClient({ accessToken: 'AT', dispatcher: agent })

const sucesso = {
  json: {
    errors: [],
    data: {
      id: 'abc123',
      name: 't3_abc123',
      url: 'https://www.reddit.com/r/minhacomunidade/comments/abc123/titulo/',
    },
  },
}

const payloadLink = {
  subredditName: 'minhacomunidade',
  postKind: 'link' as const,
  title: 'Meu título',
  url: 'https://exemplo.com/v',
  body: null,
  flairId: null,
  nsfw: false,
  spoiler: false,
}

/** Captura o corpo enviado, para conferir o que de fato saiu. */
function interceptarCorpo(status = 200, resposta: unknown = sucesso) {
  const capturado = { body: '' }
  pool()
    .intercept({ path: submitPath, method: 'POST' })
    .reply(status, (opts: { body?: unknown }) => {
      capturado.body = String(opts.body)
      return resposta
    })
  return capturado
}

describe('submitPost', () => {
  it('envia link post com kind=link e url', async () => {
    const req = interceptarCorpo()
    await submitPost(client(), payloadLink)

    expect(req.body).toContain('kind=link')
    expect(req.body).toContain('sr=minhacomunidade')
    expect(req.body).toContain('url=https%3A%2F%2Fexemplo.com%2Fv')
    expect(req.body).not.toContain('text=')
  })

  it('envia self post com kind=self e text', async () => {
    const req = interceptarCorpo()
    await submitPost(client(), {
      ...payloadLink,
      postKind: 'self',
      url: null,
      body: 'meu texto',
    })

    expect(req.body).toContain('kind=self')
    expect(req.body).toContain('text=meu+texto')
    expect(req.body).not.toContain('url=')
  })

  it('devolve id, fullname e permalink', async () => {
    pool().intercept({ path: submitPath, method: 'POST' }).reply(200, sucesso)

    const r = await submitPost(client(), payloadLink)
    expect(r).toEqual({
      redditPostId: 'abc123',
      redditFullname: 't3_abc123',
      permalink:
        'https://www.reddit.com/r/minhacomunidade/comments/abc123/titulo/',
    })
  })

  it('envia flair quando informado', async () => {
    const req = interceptarCorpo()
    await submitPost(client(), { ...payloadLink, flairId: 'flair-abc' })
    expect(req.body).toContain('flair_id=flair-abc')
  })

  it('omite flair quando não informado', async () => {
    const req = interceptarCorpo()
    await submitPost(client(), payloadLink)
    expect(req.body).not.toContain('flair_id')
  })

  it('envia nsfw e spoiler quando marcados', async () => {
    const req = interceptarCorpo()
    await submitPost(client(), { ...payloadLink, nsfw: true, spoiler: true })
    expect(req.body).toContain('nsfw=true')
    expect(req.body).toContain('spoiler=true')
  })

  it('não envia resubmit nem sendreplies inventados', async () => {
    // O corpo precisa conter só o que decidimos enviar.
    const req = interceptarCorpo()
    await submitPost(client(), payloadLink)
    const chaves = [...new URLSearchParams(req.body).keys()].sort()
    expect(chaves).toEqual(['api_type', 'kind', 'sr', 'title', 'url'])
  })

  it('marca a requisição como tendo efeito colateral', async () => {
    // Consequência: 5xx vira unknown, não retentável.
    pool().intercept({ path: submitPath, method: 'POST' }).reply(503, {})

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
    })
  })

  it('queda de conexão vira resultado desconhecido', async () => {
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      disposition: 'unknown',
    })
  })

  it('200 com json.errors vira erro terminal', async () => {
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, {
        json: { errors: [['SUBREDDIT_NOTALLOWED', 'não permitido', 'sr']] },
      })

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      disposition: 'terminal',
    })
  })

  it('resposta sem fullname é tratada como resultado desconhecido', async () => {
    // Sem o fullname não há como comentar nem registrar o permalink; e como o
    // post pode ter sido criado, retentar seria arriscado.
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, { json: { errors: [], data: {} } })

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    })
  })

  it('resposta sem permalink ainda é sucesso', async () => {
    // O permalink é conveniência; id e fullname é que são essenciais.
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, { json: { errors: [], data: { id: 'x1', name: 't3_x1' } } })

    const r = await submitPost(client(), payloadLink)
    expect(r.redditFullname).toBe('t3_x1')
    expect(r.permalink).toBeNull()
  })
})
