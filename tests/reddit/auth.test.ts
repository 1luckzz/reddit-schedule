import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchIdentity,
  refreshAccessToken,
  REDDIT_SCOPES,
} from '@/lib/reddit/auth'

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

const tokenPool = () => agent.get('https://www.reddit.com')

describe('buildAuthorizeUrl', () => {
  it('monta a URL oficial com todos os parâmetros exigidos', () => {
    const url = new URL(buildAuthorizeUrl('STATE-123'))
    expect(url.origin + url.pathname).toBe(
      'https://www.reddit.com/api/v1/authorize',
    )
    expect(url.searchParams.get('client_id')).toBe('cid-fake')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('STATE-123')
    expect(url.searchParams.get('duration')).toBe('permanent')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/reddit/callback',
    )
  })

  it('pede exatamente os escopos necessários', () => {
    const url = new URL(buildAuthorizeUrl('S'))
    const scopes = url.searchParams.get('scope')!.split(' ')
    expect(scopes.sort()).toEqual([...REDDIT_SCOPES].sort())
    expect(scopes).toContain('identity')
    expect(scopes).toContain('submit')
    expect(scopes).toContain('mysubreddits')
    expect(scopes).toContain('flair')
  })

  it('nunca inclui o client_secret na URL', () => {
    expect(buildAuthorizeUrl('S')).not.toContain('csecret-fake')
  })
})

describe('exchangeCode', () => {
  it('usa HTTP Basic com client_id e client_secret', async () => {
    let auth = ''
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, (opts) => {
        auth = String((opts.headers as Record<string, string>)['authorization'])
        return {
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
          scope: 'identity submit',
          token_type: 'bearer',
        }
      })

    await exchangeCode('CODE-1', agent)

    const esperado =
      'Basic ' + Buffer.from('cid-fake:csecret-fake').toString('base64')
    expect(auth).toBe(esperado)
  })

  it('envia grant_type=authorization_code com code e redirect_uri', async () => {
    let corpo = ''
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return {
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
          scope: 'identity',
          token_type: 'bearer',
        }
      })

    await exchangeCode('CODE-1', agent)
    expect(corpo).toContain('grant_type=authorization_code')
    expect(corpo).toContain('code=CODE-1')
    expect(corpo).toContain('redirect_uri=')
  })

  it('devolve os tokens', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT-1',
        refresh_token: 'RT-1',
        expires_in: 3600,
        scope: 'identity submit',
        token_type: 'bearer',
      })

    const token = await exchangeCode('CODE-1', agent)
    expect(token.access_token).toBe('AT-1')
    expect(token.refresh_token).toBe('RT-1')
  })

  it('erro do Reddit vira RedditError terminal sem vazar o secret', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(401, { error: 'invalid_grant' })

    try {
      await exchangeCode('CODE-RUIM', agent)
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as { disposition: string }).disposition).toBe('terminal')
      expect(JSON.stringify(e)).not.toContain('csecret-fake')
      expect((e as Error).message).not.toContain('csecret-fake')
    }
  })

  it('resposta sem refresh_token é rejeitada', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT',
        expires_in: 3600,
        scope: 'identity',
        token_type: 'bearer',
      })

    await expect(exchangeCode('CODE-1', agent)).rejects.toMatchObject({
      code: 'NO_REFRESH_TOKEN',
    })
  })
})

describe('refreshAccessToken', () => {
  it('envia grant_type=refresh_token', async () => {
    let corpo = ''
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return {
          access_token: 'AT-NOVO',
          expires_in: 3600,
          scope: 'identity',
          token_type: 'bearer',
        }
      })

    const token = await refreshAccessToken('RT-1', agent)
    expect(corpo).toContain('grant_type=refresh_token')
    expect(corpo).toContain('refresh_token=RT-1')
    expect(token.access_token).toBe('AT-NOVO')
  })

  it('refresh token inválido vira erro terminal identificável', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(400, { error: 'invalid_grant' })

    await expect(refreshAccessToken('RT-RUIM', agent)).rejects.toMatchObject({
      code: 'REFRESH_INVALID',
      disposition: 'terminal',
    })
  })

  it('nenhum erro de refresh carrega o refresh token', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(400, { error: 'invalid_grant' })

    try {
      await refreshAccessToken('RT-SUPER-SECRETO', agent)
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect(JSON.stringify(e)).not.toContain('RT-SUPER-SECRETO')
      expect((e as Error).message).not.toContain('RT-SUPER-SECRETO')
    }
  })
})

describe('fetchIdentity', () => {
  it('devolve id e nome da conta', async () => {
    agent
      .get('https://oauth.reddit.com')
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(200, { id: 't2_abc', name: 'conta01' })

    const identity = await fetchIdentity('AT', agent)
    expect(identity).toEqual({ id: 't2_abc', name: 'conta01' })
  })

  it('envia o User-Agent obrigatório', async () => {
    let ua = ''
    agent
      .get('https://oauth.reddit.com')
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(200, (opts) => {
        ua = String((opts.headers as Record<string, string>)['user-agent'])
        return { id: 't2_abc', name: 'conta01' }
      })

    await fetchIdentity('AT', agent)
    expect(ua).toContain('reddit-scheduler')
  })

  it('falha vira erro terminal', async () => {
    agent
      .get('https://oauth.reddit.com')
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(403, {})

    await expect(fetchIdentity('AT', agent)).rejects.toMatchObject({
      code: 'IDENTITY_FAILED',
      disposition: 'terminal',
    })
  })
})
