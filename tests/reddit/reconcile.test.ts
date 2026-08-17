import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { findCandidates } from '@/lib/reddit/reconcile'

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
const submittedPath = (p: string) => p.includes('/submitted')
const client = () =>
  createRedditClient({ accessToken: 'AT', dispatcher: agent })

const agora = Math.floor(Date.now() / 1000)

function t3(over: Record<string, unknown> = {}) {
  return {
    kind: 't3',
    data: {
      id: 'abc123',
      name: 't3_abc123',
      title: 'Meu título',
      subreddit: 'minhacomunidade',
      permalink: '/r/minhacomunidade/comments/abc123/meu_titulo/',
      created_utc: agora - 120,
      ...over,
    },
  }
}

const listing = (children: unknown[]) => ({
  kind: 'Listing',
  data: { after: null, children },
})

const alvo = {
  username: 'conta01',
  subredditName: 'minhacomunidade',
  title: 'Meu título',
  attemptedAt: new Date(Date.now() - 120_000),
}

describe('findCandidates', () => {
  it('encontra publicação compatível', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3()]))

    const c = await findCandidates(client(), alvo)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({
      redditPostId: 'abc123',
      redditFullname: 't3_abc123',
      title: 'Meu título',
    })
    expect(c[0].permalink).toContain('reddit.com')
  })

  it('usa o endpoint do usuário informado', async () => {
    let url = ''
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, (opts: { path?: unknown }) => {
        url = String(opts.path)
        return listing([])
      })

    await findCandidates(client(), alvo)
    expect(url).toContain('/user/conta01/submitted')
  })

  it('descarta publicação de outra comunidade', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ subreddit: 'outracomunidade' })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(0)
  })

  it('descarta publicação com título diferente', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ title: 'Outro assunto' })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(0)
  })

  it('compara título ignorando espaços e caixa', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ title: '  MEU TÍTULO  ' })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(1)
  })

  it('descarta publicação fora da janela de tempo', async () => {
    // Publicada dois dias antes da tentativa: não pode ser esta.
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ created_utc: agora - 172_800 })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(0)
  })

  it('aceita publicação um pouco posterior à tentativa', async () => {
    // O Reddit pode registrar alguns segundos depois do envio.
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ created_utc: agora - 100 })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(1)
  })

  it('devolve lista vazia quando não há nada compatível', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([]))
    expect(await findCandidates(client(), alvo)).toEqual([])
  })

  it('ignora children que não são publicações', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([{ kind: 't1', data: { id: 'x' } }, t3()]))

    expect(await findCandidates(client(), alvo)).toHaveLength(1)
  })

  it('ignora entrada sem fullname ou sem horário', async () => {
    // Sem identificador não há o que registrar; sem horário não há como
    // situar a publicação na janela.
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(
        200,
        listing([t3({ name: undefined }), t3({ created_utc: undefined })]),
      )

    expect(await findCandidates(client(), alvo)).toHaveLength(0)
  })

  it('devolve MAIS DE UM candidato quando há ambiguidade', async () => {
    // O caso que mais importa: dois compatíveis significam que publicou duas
    // vezes ou que há homônimos. A função não escolhe — entrega os dois para
    // a pessoa decidir.
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(
        200,
        listing([t3(), t3({ id: 'def456', name: 't3_def456' })]),
      )

    const c = await findCandidates(client(), alvo)
    expect(c).toHaveLength(2)
    expect(c.map((x) => x.redditPostId)).toEqual(['abc123', 'def456'])
  })

  it('é uma leitura: usa GET e não marca efeito colateral', async () => {
    let metodo = ''
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, (opts: { method?: unknown }) => {
        metodo = String(opts.method)
        return listing([])
      })

    await findCandidates(client(), alvo)
    expect(metodo).toBe('GET')
  })

  it('5xx propaga como retentável, sem inventar resultado', async () => {
    // Sem efeito colateral marcado, um 5xx é indisponibilidade — e nunca
    // deve virar "não encontrei nada", que a pessoa leria como "não publicou".
    pool().intercept({ path: submittedPath, method: 'GET' }).reply(503, {})
    await expect(findCandidates(client(), alvo)).rejects.toMatchObject({
      disposition: 'retryable',
    })
  })

  it('403 propaga: falta de permissão não é ausência de publicação', async () => {
    pool().intercept({ path: submittedPath, method: 'GET' }).reply(403, {})
    await expect(findCandidates(client(), alvo)).rejects.toMatchObject({
      disposition: 'terminal',
    })
  })
})
