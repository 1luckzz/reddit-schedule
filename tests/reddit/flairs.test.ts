import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { listLinkFlairs } from '@/lib/reddit/flairs'

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
const flairPath = (p: string) =>
  p.startsWith('/r/minhacomunidade/api/link_flair_v2')

const client = () => createRedditClient({ accessToken: 'AT', dispatcher: agent })

const flair = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: `Flair ${id}`,
  type: 'text',
  text_editable: false,
  mod_only: false,
  background_color: '#ff4500',
  text_color: 'light',
  allowable_content: 'all',
  max_emojis: 10,
  css_class: '',
  ...extra,
})

describe('listLinkFlairs', () => {
  it('normaliza os flairs da comunidade', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, [flair('abc'), flair('def')])

    const flairs = await listLinkFlairs(client(), 'minhacomunidade')
    expect(flairs).toHaveLength(2)
    expect(flairs[0]).toEqual({
      id: 'abc',
      text: 'Flair abc',
      textEditable: false,
      modOnly: false,
      backgroundColor: '#ff4500',
      textColor: 'light',
    })
  })

  it('usa o endpoint v2, não o depreciado', async () => {
    let url = ''
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, (opts) => {
        url = String(opts.path)
        return []
      })

    await listLinkFlairs(client(), 'minhacomunidade')
    expect(url).toContain('link_flair_v2')
  })

  it('200 com array vazio é resultado válido: a comunidade não tem flair', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(200, [])
    expect(await listLinkFlairs(client(), 'minhacomunidade')).toEqual([])
  })

  it('403 lança, em vez de fingir que não há flair', async () => {
    // Devolver [] aqui faria o formulário afirmar algo que não sabe.
    pool().intercept({ path: flairPath, method: 'GET' }).reply(403, {})
    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'FLAIRS_UNAVAILABLE' })
  })

  it('404 lança', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(404, {})
    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'FLAIRS_UNAVAILABLE' })
  })

  it('a mensagem de indisponibilidade diz que não foi possível verificar', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(403, {})
    try {
      await listLinkFlairs(client(), 'minhacomunidade')
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/não foi possível/i)
      // Não pode afirmar ausência de flair.
      expect(msg).not.toMatch(/não (tem|possui|usa) flair/i)
    }
  })

  it('descarta flair sem id, que não daria para enviar', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, [flair('ok'), { text: 'sem id' }])

    const flairs = await listLinkFlairs(client(), 'minhacomunidade')
    expect(flairs.map((f) => f.id)).toEqual(['ok'])
  })

  it('marca flair exclusivo de moderador', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, [flair('mod', { mod_only: true })])

    const flairs = await listLinkFlairs(client(), 'minhacomunidade')
    expect(flairs[0].modOnly).toBe(true)
  })

  it('resposta 200 que não é array lança, por ser formato inesperado', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, { erro: 'formato inesperado' })

    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'FLAIRS_UNAVAILABLE' })
  })

  it('erro de servidor propaga como transitório', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(503, {})
    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ disposition: 'retryable' })
  })
})
