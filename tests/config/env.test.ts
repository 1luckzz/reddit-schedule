import { beforeEach, describe, expect, it, vi } from 'vitest'

const VALID_KEY = Buffer.alloc(32, 7).toString('base64')

function loadEnv() {
  vi.resetModules()
  return import('@/lib/config/env')
}

function setCore() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x'
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_x'
  process.env.ENCRYPTION_KEY = VALID_KEY
  process.env.APP_URL = 'http://localhost:3000'
}

describe('getCoreEnv', () => {
  beforeEach(setCore)

  it('devolve o ambiente quando tudo é válido', async () => {
    const { getCoreEnv } = await loadEnv()
    expect(getCoreEnv().APP_URL).toBe('http://localhost:3000')
  })

  it('rejeita ENCRYPTION_KEY que não tem 32 bytes', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64')
    const { getCoreEnv } = await loadEnv()
    expect(() => getCoreEnv()).toThrow(/ENCRYPTION_KEY/)
  })

  it('rejeita URL malformada', async () => {
    process.env.APP_URL = 'nao-e-url'
    const { getCoreEnv } = await loadEnv()
    expect(() => getCoreEnv()).toThrow(/APP_URL/)
  })

  it('lista todas as variáveis faltando de uma vez', async () => {
    delete process.env.SUPABASE_SECRET_KEY
    delete process.env.APP_URL
    const { getCoreEnv } = await loadEnv()
    expect(() => getCoreEnv()).toThrow(/SUPABASE_SECRET_KEY/)
    expect(() => getCoreEnv()).toThrow(/APP_URL/)
  })

  it('a mensagem de erro não inclui o valor das variáveis', async () => {
    process.env.ENCRYPTION_KEY = 'chave-invalida-secreta'
    const { getCoreEnv } = await loadEnv()
    try {
      getCoreEnv()
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).not.toContain('chave-invalida-secreta')
    }
  })
})

describe('getRedditEnv', () => {
  beforeEach(setCore)

  it('falha de forma independente do core quando ausente', async () => {
    delete process.env.REDDIT_CLIENT_ID
    delete process.env.REDDIT_CLIENT_SECRET
    delete process.env.REDDIT_REDIRECT_URI
    delete process.env.REDDIT_USER_AGENT
    const { getCoreEnv, getRedditEnv } = await loadEnv()
    expect(() => getCoreEnv()).not.toThrow()
    expect(() => getRedditEnv()).toThrow(/REDDIT_CLIENT_ID/)
  })

  it('aceita as credenciais do Reddit quando presentes', async () => {
    process.env.REDDIT_CLIENT_ID = 'cid'
    process.env.REDDIT_CLIENT_SECRET = 'csecret'
    process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
    process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:0.1.0 (by /u/teste)'
    const { getRedditEnv } = await loadEnv()
    expect(getRedditEnv().REDDIT_CLIENT_ID).toBe('cid')
  })
})
