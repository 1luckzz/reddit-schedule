import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { listModeratedSubreddits, MAX_PAGES } from '@/lib/reddit/communities'

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
const moderator = (p: string) => p.startsWith('/subreddits/mine/moderator')

function t5(nome: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 't5',
    data: {
      id: nome,
      name: `t5_${nome}`,
      display_name: nome,
      display_name_prefixed: `r/${nome}`,
      title: `Comunidade ${nome}`,
      url: `/r/${nome}/`,
      over18: false,
      subscribers: 1234,
      user_is_moderator: true,
      submission_type: 'any',
      subreddit_type: 'public',
      link_flair_enabled: true,
      can_assign_link_flair: true,
      ...extra,
    },
  }
}

function listing(children: unknown[], after: string | null = null) {
  return { kind: 'Listing', data: { after, before: null, children } }
}

function client() {
  return createRedditClient({ accessToken: 'AT', dispatcher: agent })
}

describe('listModeratedSubreddits', () => {
  it('normaliza os campos de um t5', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('minhacomunidade')]))

    const subs = await listModeratedSubreddits(client())
    expect(subs).toHaveLength(1)
    expect(subs[0]).toEqual({
      fullname: 't5_minhacomunidade',
      name: 'minhacomunidade',
      displayName: 'Comunidade minhacomunidade',
      url: '/r/minhacomunidade/',
      over18: false,
      submissionType: 'any',
      linkFlairEnabled: true,
      canAssignLinkFlair: true,
      subredditType: 'public',
    })
  })

  it('segue a paginação pelo cursor after', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('primeira')], 't5_primeira'))
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('segunda')]))

    const subs = await listModeratedSubreddits(client())
    expect(subs.map((s) => s.name)).toEqual(['primeira', 'segunda'])
  })

  it('envia o cursor after na requisição seguinte', async () => {
    let segundaUrl = ''
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('primeira')], 'CURSOR-1'))
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, (opts) => {
        segundaUrl = String(opts.path)
        return listing([t5('segunda')])
      })

    await listModeratedSubreddits(client())
    expect(segundaUrl).toContain('after=CURSOR-1')
  })

  it('para no teto de páginas mesmo se a API repetir o cursor', async () => {
    // Cursor que nunca muda, com comunidades distintas por página: sem teto,
    // isto seria um laço infinito. Os nomes precisam variar para separar
    // "parou pelo teto" de "parou por deduplicação".
    for (let i = 0; i < MAX_PAGES + 2; i++) {
      pool()
        .intercept({ path: moderator, method: 'GET' })
        .reply(200, listing([t5(`repetida${i}`)], 'CURSOR-FIXO'))
    }

    const subs = await listModeratedSubreddits(client())
    expect(subs).toHaveLength(MAX_PAGES)
  })

  it('deduplica comunidade repetida entre páginas', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('mesma')], 'CURSOR-1'))
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('mesma')]))

    const subs = await listModeratedSubreddits(client())
    expect(subs).toHaveLength(1)
  })

  it('devolve lista vazia quando a conta não modera nada', async () => {
    pool().intercept({ path: moderator, method: 'GET' }).reply(200, listing([]))
    expect(await listModeratedSubreddits(client())).toEqual([])
  })

  it('ignora children que não são t5', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('valida'), { kind: 't2', data: { id: 'x' } }]))

    const subs = await listModeratedSubreddits(client())
    expect(subs.map((s) => s.name)).toEqual(['valida'])
  })

  it('aceita over_18 além de over18', async () => {
    // A API é inconsistente entre endpoints; aceitamos as duas formas.
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('nsfw', { over18: undefined, over_18: true })]))

    const subs = await listModeratedSubreddits(client())
    expect(subs[0].over18).toBe(true)
  })

  it('trata submission_type ausente como any', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('sem_tipo', { submission_type: undefined })]))

    const subs = await listModeratedSubreddits(client())
    expect(subs[0].submissionType).toBe('any')
  })

  it('trata submission_type desconhecido como any', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('tipo_novo', { submission_type: 'inventado' })]))

    const subs = await listModeratedSubreddits(client())
    expect(subs[0].submissionType).toBe('any')
  })

  it('descarta entrada sem fullname, que não daria para identificar', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('ok'), t5('quebrada', { name: undefined })]))

    const subs = await listModeratedSubreddits(client())
    expect(subs.map((s) => s.name)).toEqual(['ok'])
  })

  it('usa o nome como display quando o title vem vazio', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('sem_titulo', { title: undefined })]))

    const subs = await listModeratedSubreddits(client())
    expect(subs[0].displayName).toBe('sem_titulo')
  })

  it('pede o limite máximo por página', async () => {
    let url = ''
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, (opts) => {
        url = String(opts.path)
        return listing([])
      })

    await listModeratedSubreddits(client())
    expect(url).toContain('limit=100')
  })

  it('propaga erro da API sem engolir', async () => {
    pool().intercept({ path: moderator, method: 'GET' }).reply(403, {})
    await expect(listModeratedSubreddits(client())).rejects.toMatchObject({
      code: 'NO_PERMISSION',
    })
  })
})
