import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createHash, randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { encryptSecret } from '@/lib/crypto/aes-gcm'
import type { VerifiedAccount } from '@/lib/auth/ownership'

let userA: { id: string; accessToken: string }
let account: VerifiedAccount
let agent: MockAgent

const pool = () => agent.get('https://oauth.reddit.com')
const moderator = (p: string) => p.startsWith('/subreddits/mine/moderator')

function t5(nome: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 't5',
    data: {
      id: nome,
      name: `t5_${nome}`,
      display_name: nome,
      title: `Comunidade ${nome}`,
      url: `/r/${nome}/`,
      over18: false,
      submission_type: 'any',
      subreddit_type: 'public',
      link_flair_enabled: true,
      can_assign_link_flair: true,
      ...extra,
    },
  }
}

const listing = (children: unknown[]) => ({
  kind: 'Listing',
  data: { after: null, before: null, children },
})

async function sync() {
  const { syncCommunitiesFor } = await import('@/lib/reddit/sync-communities')
  return syncCommunitiesFor(account, {
    dispatcher: agent,
    skipOwnershipCheck: true,
  })
}

async function lerComunidades() {
  const { data } = await adminClient()
    .from('subreddits')
    .select('name, status, last_synced_at, submission_type')
    .eq('reddit_account_id', account.id)
    .order('name')
  return data ?? []
}

// ATENÇÃO: os testes deste arquivo compartilham estado de propósito e devem
// rodar na ordem escrita — eles simulam sincronizações sucessivas da mesma
// conta (cria, repete, some, volta). Reordenar quebra o cenário.

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  userA = await createTestUser(`sc-${Date.now()}@teste.local`)

  const { data } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_sc_${Date.now()}`,
      username: 'conta_sync',
      scopes: ['identity', 'mysubreddits'],
    })
    .select('id, owner_id')
    .single()
  account = data as unknown as VerifiedAccount

  await adminClient().from('reddit_account_secrets').insert({
    reddit_account_id: account.id,
    owner_id: userA.id,
    access_token_enc: encryptSecret(
      'AT',
      `reddit_account_secrets:access_token:${account.id}`,
    ),
    refresh_token_enc: encryptSecret(
      'RT',
      `reddit_account_secrets:refresh_token:${account.id}`,
    ),
    access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })
})

// client_id próprio deste arquivo: o orçamento é global e o Vitest roda
// arquivos em paralelo, então apagar a linha dos outros zeraria o cenário
// que eles acabaram de montar.
const CLIENT_ID = 'cid-suite-sync'
const HASH = createHash('sha256').update(CLIENT_ID).digest('hex')

beforeEach(async () => {
  process.env.REDDIT_CLIENT_ID = CLIENT_ID
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
  await adminClient()
    .from('reddit_api_budget')
    .delete()
    .eq('client_id_hash', HASH)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('syncCommunitiesFor', () => {
  it('cria as comunidades na primeira sincronização', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('alpha'), t5('beta')]))

    const resultado = await sync()
    expect(resultado).toMatchObject({ criadas: 2, removidas: 0, total: 2 })

    const comunidades = await lerComunidades()
    expect(comunidades.map((c) => c.name)).toEqual(['alpha', 'beta'])
    expect(comunidades.every((c) => c.status === 'active')).toBe(true)
    expect(comunidades.every((c) => c.last_synced_at !== null)).toBe(true)
  })

  it('não duplica ao sincronizar de novo', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('alpha'), t5('beta')]))

    const resultado = await sync()
    expect(resultado.criadas).toBe(0)
    expect(resultado.atualizadas).toBe(2)
    expect(await lerComunidades()).toHaveLength(2)
  })

  it('marca como removida a comunidade que sumiu, sem apagar', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('alpha')]))

    const resultado = await sync()
    expect(resultado.removidas).toBe(1)

    const comunidades = await lerComunidades()
    // A linha continua existindo: publicações agendadas apontam para ela.
    expect(comunidades).toHaveLength(2)
    expect(comunidades.find((c) => c.name === 'beta')!.status).toBe('removed')
    expect(comunidades.find((c) => c.name === 'alpha')!.status).toBe('active')
  })

  it('reativa a comunidade que voltou', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('alpha'), t5('beta')]))

    await sync()
    const comunidades = await lerComunidades()
    expect(comunidades.find((c) => c.name === 'beta')!.status).toBe('active')
  })

  it('atualiza metadados que mudaram no Reddit', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('alpha', { submission_type: 'link' }), t5('beta')]))

    await sync()
    const comunidades = await lerComunidades()
    expect(comunidades.find((c) => c.name === 'alpha')!.submission_type).toBe(
      'link',
    )
  })

  it('grava o owner_id da conta, nunca outro', async () => {
    const { data } = await adminClient()
      .from('subreddits')
      .select('owner_id')
      .eq('reddit_account_id', account.id)
    expect(data!.every((s) => s.owner_id === userA.id)).toBe(true)
  })

  it('recusa sincronizar quando o orçamento está esgotado', async () => {
    const { reserveBudget, reconcileBudget, BUDGET_THRESHOLD } = await import(
      '@/lib/reddit/budget'
    )
    await reserveBudget()
    await reconcileBudget({
      used: 100,
      remaining: BUDGET_THRESHOLD - 1,
      resetSeconds: 300,
    })

    // Nenhum intercept: se a sincronização chamasse a API, o teste falharia.
    await expect(sync()).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
  })

  it('não deixa o banco pela metade quando a API falha no meio da paginação', async () => {
    const antes = await lerComunidades()

    // Primeira página vem bem e aponta para uma segunda; a segunda falha.
    // Este é o cenário que importa: metade da listagem chegou.
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, {
        kind: 'Listing',
        data: {
          after: 'CURSOR-1',
          before: null,
          children: [t5('nova_pagina_1')],
        },
      })
    pool().intercept({ path: moderator, method: 'GET' }).reply(503, {})

    await expect(sync()).rejects.toBeTruthy()

    // Nada da primeira página foi gravado: a listagem completa vem antes de
    // qualquer escrita.
    const depois = await lerComunidades()
    expect(depois).toHaveLength(antes.length)
    expect(depois.map((c) => c.name)).not.toContain('nova_pagina_1')
  })
})
