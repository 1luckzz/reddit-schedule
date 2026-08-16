import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { FIELD_DEFAULTS, getPostRequirements } from '@/lib/reddit/requirements'

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
const reqPath = (p: string) =>
  p.startsWith('/api/v1/minhacomunidade/post_requirements')

const client = () => createRedditClient({ accessToken: 'AT', dispatcher: agent })

describe('getPostRequirements', () => {
  it('normaliza a resposta completa', async () => {
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, {
        title_text_min_length: 5,
        title_text_max_length: 300,
        body_restriction_policy: 'required',
        is_flair_required: true,
        domain_whitelist: ['youtube.com'],
        domain_blacklist: ['spam.com'],
        title_blacklisted_strings: ['proibido'],
        body_blacklisted_strings: ['tambem proibido'],
      })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req).toEqual({
      titleMinLength: 5,
      titleMaxLength: 300,
      bodyRestrictionPolicy: 'required',
      isFlairRequired: true,
      domainWhitelist: ['youtube.com'],
      domainBlacklist: ['spam.com'],
      titleBlacklistedStrings: ['proibido'],
      bodyBlacklistedStrings: ['tambem proibido'],
    })
  })

  it('resposta 200 vazia significa comunidade sem restrições', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    expect(await getPostRequirements(client(), 'minhacomunidade')).toEqual(
      FIELD_DEFAULTS,
    )
  })

  it('preenche apenas os campos ausentes de uma resposta parcial', async () => {
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { is_flair_required: true })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.isFlairRequired).toBe(true)
    expect(req.bodyRestrictionPolicy).toBe(FIELD_DEFAULTS.bodyRestrictionPolicy)
    expect(req.domainWhitelist).toEqual([])
  })

  it('o default de campo não impõe restrição que a comunidade não pediu', () => {
    expect(FIELD_DEFAULTS.bodyRestrictionPolicy).toBe('none')
    expect(FIELD_DEFAULTS.isFlairRequired).toBe(false)
    expect(FIELD_DEFAULTS.domainWhitelist).toEqual([])
  })

  it('o título nunca passa do limite do Reddit', async () => {
    // 300 é o teto da API; uma comunidade não pode ampliá-lo.
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { title_text_max_length: 9999 })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.titleMaxLength).toBe(300)
  })

  it('body_restriction_policy desconhecida vira none', async () => {
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { body_restriction_policy: 'inventado' })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.bodyRestrictionPolicy).toBe('none')
  })

  it('campos de lista ausentes viram array vazio, nunca null', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.domainBlacklist).toEqual([])
    expect(req.titleBlacklistedStrings).toEqual([])
  })

  it('403 lança, em vez de virar requisitos permissivos', async () => {
    // Aplicar defaults aqui liberaria um agendamento sem saber as regras.
    pool().intercept({ path: reqPath, method: 'GET' }).reply(403, {})
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'REQUIREMENTS_UNAVAILABLE' })
  })

  it('404 lança', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(404, {})
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'REQUIREMENTS_UNAVAILABLE' })
  })

  it('resposta 200 que não é objeto lança', async () => {
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, JSON.stringify('texto solto'), {
        headers: { 'content-type': 'application/json' },
      })
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toBeTruthy()
  })

  it('a mensagem diz que não foi possível verificar, sem afirmar ausência', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(403, {})
    try {
      await getPostRequirements(client(), 'minhacomunidade')
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/não foi possível/i)
      expect(msg).not.toMatch(/sem restri|não (tem|possui) requisito/i)
    }
  })

  it('erro transitório propaga com a disposição original', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(503, {})
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ disposition: 'retryable' })
  })
})
