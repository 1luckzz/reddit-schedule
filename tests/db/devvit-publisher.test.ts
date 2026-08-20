import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

// ---------------------------------------------------------------
// O caminho Devvit no banco: o worker antigo NUNCA pode reivindicar um job
// destinado ao Devvit — publicaria em duplicidade, pela identidade errada.
// ---------------------------------------------------------------

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let conta: string
let sub: string
let instalacao: string

const SUB_NAME = 'com_devvit'

async function criarPost(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_id: sub,
      title: 'Job de teste',
      url: 'https://exemplo.com/v',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      timezone: 'America/Sao_Paulo',
      status: 'scheduled',
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

/** Post do caminho Devvit, pronto para publicar. */
const criarPostDevvit = (overrides: Record<string, unknown> = {}) =>
  criarPost({
    publisher: 'devvit',
    devvit_installation_id: instalacao,
    devvit_sync_status: 'pending',
    ...overrides,
  })

const claim = (workerId: string, batch = 10) =>
  adminClient().rpc('claim_due_posts', {
    p_worker_id: workerId,
    p_batch: batch,
  })

const claimCom = (workerId: string, batch = 10) =>
  adminClient().rpc('claim_due_comments', {
    p_worker_id: workerId,
    p_batch: batch,
  })

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`dv-${stamp}@teste.local`)
  userB = await createTestUser(`dv-b-${stamp}@teste.local`)

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_dv_${stamp}`,
      username: 'conta_devvit',
      min_interval_seconds: 0,
    })
    .select('id')
    .single()
  conta = c!.id as string

  const { data: s } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_fullname: `t5_dv_${stamp}`,
      name: SUB_NAME,
      display_name: 'Comunidade Devvit',
      url: `/r/${SUB_NAME}/`,
    })
    .select('id')
    .single()
  sub = s!.id as string

  const { data: i, error } = await adminClient()
    .from('devvit_installations')
    .insert({
      owner_id: userA.id,
      subreddit_name: SUB_NAME,
      app_slug: 'grapepos2',
      install_location_id: `t5_dv_${stamp}`,
    })
    .select('id')
    .single()
  if (error) throw error
  instalacao = i!.id as string
})

beforeEach(async () => {
  // A fila do worker é global: testes de contagem exata controlam a fila
  // inteira, como nos demais arquivos de claim.
  await adminClient()
    .from('scheduled_comments')
    .delete()
    .in('status', ['scheduled', 'processing'])
  await adminClient()
    .from('scheduled_posts')
    .delete()
    .in('status', ['scheduled', 'processing'])
  await adminClient().from('scheduled_posts').delete().eq('owner_id', userA.id)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('claims ignoram o caminho Devvit', () => {
  it('claim_due_posts NÃO reivindica post publisher=devvit vencido', async () => {
    await criarPostDevvit()
    const { data, error } = await claim('worker-1')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('controle positivo: o mesmo post com publisher=worker É reivindicado', async () => {
    // Sem este controle, o teste acima passaria com um claim quebrado que não
    // reivindica nada.
    const id = await criarPost()
    const { data } = await claim('worker-1')
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(id)
  })

  it('CORRIDA: dois workers em paralelo nunca tocam os jobs devvit', async () => {
    const devvit = []
    const worker = []
    for (let i = 0; i < 3; i++) devvit.push(await criarPostDevvit())
    for (let i = 0; i < 3; i++) worker.push(await criarPost())

    const [a, b] = await Promise.all([
      claim('worker-1', 10),
      claim('worker-2', 10),
    ])
    const pegos = [
      ...(a.data ?? []).map((r: { id: string }) => r.id),
      ...(b.data ?? []).map((r: { id: string }) => r.id),
    ]

    // Todos os worker saem, nenhum devvit sai — e sem duplicata.
    expect(new Set(pegos).size).toBe(pegos.length)
    expect([...pegos].sort()).toEqual([...worker].sort())
    for (const id of devvit) expect(pegos).not.toContain(id)

    // E os devvit continuam intocados no banco: scheduled, sem lock.
    const { data: linhas } = await adminClient()
      .from('scheduled_posts')
      .select('id, status, locked_by')
      .in('id', devvit)
    expect(linhas).toHaveLength(3)
    for (const linha of linhas!) {
      expect(linha.status).toBe('scheduled')
      expect(linha.locked_by).toBeNull()
    }
  })

  it('claim_due_comments NÃO reivindica comentário de post devvit publicado', async () => {
    const post = await criarPostDevvit({
      status: 'published',
      devvit_sync_status: 'accepted',
      reddit_fullname: `t3_${Math.random().toString(36).slice(2, 10)}`,
      published_at: new Date().toISOString(),
    })
    await adminClient().from('scheduled_comments').insert({
      owner_id: userA.id,
      scheduled_post_id: post,
      reddit_account_id: conta,
      body: 'comentário devvit',
      mode: 'absolute',
      scheduled_at: new Date(Date.now() - 30_000).toISOString(),
      status: 'scheduled',
    })

    const { data } = await claimCom('worker-1')
    expect(data).toHaveLength(0)
  })

  it('controle positivo: comentário de post worker publicado É reivindicado', async () => {
    const post = await criarPost({
      status: 'published',
      reddit_fullname: `t3_${Math.random().toString(36).slice(2, 10)}`,
      published_at: new Date().toISOString(),
    })
    await adminClient().from('scheduled_comments').insert({
      owner_id: userA.id,
      scheduled_post_id: post,
      reddit_account_id: conta,
      body: 'comentário worker',
      mode: 'absolute',
      scheduled_at: new Date(Date.now() - 30_000).toISOString(),
      status: 'scheduled',
    })

    const { data } = await claimCom('worker-1')
    expect(data).toHaveLength(1)
  })
})

describe('create_scheduled_post com publisher=devvit', () => {
  /** Payload devvit canônico: SEM conta e SEM comunidade legacy. */
  const chamarRpcDevvit = (
    post: Record<string, unknown> = {},
    comment: Record<string, unknown> | null = null,
  ) =>
    adminClient().rpc('create_scheduled_post', {
      p_owner_id: userA.id,
      p_post: {
        title: 'Post devvit',
        url: 'https://exemplo.com/d',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
        status: 'scheduled',
        publisher: 'devvit',
        devvit_installation_id: instalacao,
        ...post,
      },
      p_comment: comment,
    })

  const chamarRpcWorker = (post: Record<string, unknown> = {}) =>
    adminClient().rpc('create_scheduled_post', {
      p_owner_id: userA.id,
      p_post: {
        reddit_account_id: conta,
        subreddit_id: sub,
        title: 'Post worker',
        url: 'https://exemplo.com/w',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
        status: 'scheduled',
        ...post,
      },
    })

  it('cria post devvit SEM conta e SEM comunidade, com sync pending', async () => {
    const { data, error } = await chamarRpcDevvit()
    expect(error).toBeNull()

    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select(
        'publisher, devvit_installation_id, devvit_sync_status, devvit_job_id, reddit_account_id, subreddit_id',
      )
      .eq('id', data as string)
      .single()
    expect(linha!.publisher).toBe('devvit')
    expect(linha!.devvit_installation_id).toBe(instalacao)
    expect(linha!.devvit_sync_status).toBe('pending')
    expect(linha!.devvit_job_id).toBeNull()
    expect(linha!.reddit_account_id).toBeNull()
    expect(linha!.subreddit_id).toBeNull()
  })

  it('o comentário do post devvit nasce sem conta Reddit', async () => {
    const { data, error } = await chamarRpcDevvit(
      {},
      { body: 'primeiro comentário', mode: 'immediate' },
    )
    expect(error).toBeNull()

    const { data: comentario } = await adminClient()
      .from('scheduled_comments')
      .select('reddit_account_id, mode, status')
      .eq('scheduled_post_id', data as string)
      .single()
    expect(comentario!.reddit_account_id).toBeNull()
    expect(comentario!.mode).toBe('immediate')
  })

  it('rejeita conta ou comunidade legacy junto de devvit', async () => {
    const comConta = await chamarRpcDevvit({ reddit_account_id: conta })
    expect(comConta.error).not.toBeNull()

    const comSub = await chamarRpcDevvit({ subreddit_id: sub })
    expect(comSub.error).not.toBeNull()
  })

  it('worker continua exigindo conta e comunidade', async () => {
    const semConta = await chamarRpcWorker({ reddit_account_id: null })
    expect(semConta.error).not.toBeNull()

    const semSub = await chamarRpcWorker({ subreddit_id: null })
    expect(semSub.error).not.toBeNull()

    // Controle positivo: com os dois, o worker cria normalmente.
    const completo = await chamarRpcWorker()
    expect(completo.error).toBeNull()
    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select('publisher, devvit_installation_id, devvit_sync_status')
      .eq('id', completo.data as string)
      .single()
    expect(linha!.publisher).toBe('worker')
    expect(linha!.devvit_installation_id).toBeNull()
    expect(linha!.devvit_sync_status).toBeNull()
  })

  it('rejeita devvit sem instalação', async () => {
    const { error } = await chamarRpcDevvit({ devvit_installation_id: null })
    expect(error).not.toBeNull()
  })

  it('rejeita instalação inexistente', async () => {
    const { error } = await chamarRpcDevvit({
      devvit_installation_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(error).not.toBeNull()
  })

  it('rejeita instalação desativada', async () => {
    await adminClient()
      .from('devvit_installations')
      .update({ status: 'disabled' })
      .eq('id', instalacao)
    try {
      const { error } = await chamarRpcDevvit()
      expect(error).not.toBeNull()
    } finally {
      await adminClient()
        .from('devvit_installations')
        .update({ status: 'active' })
        .eq('id', instalacao)
    }
  })

  it('rejeita instalação de outro owner', async () => {
    const { data: alheia } = await adminClient()
      .from('devvit_installations')
      .insert({
        owner_id: userB.id,
        subreddit_name: SUB_NAME,
        app_slug: 'grapepos2',
      })
      .select('id')
      .single()

    const { error } = await chamarRpcDevvit({
      devvit_installation_id: alheia!.id,
    })
    expect(error).not.toBeNull()
  })

  it('rejeita instalação junto de publisher=worker', async () => {
    const { error } = await chamarRpcWorker({
      devvit_installation_id: instalacao,
    })
    expect(error).not.toBeNull()
  })

  it('rejeita publisher desconhecido', async () => {
    const { error } = await chamarRpcWorker({ publisher: 'lambda' })
    expect(error).not.toBeNull()
  })

  it('instalação com histórico não pode ser apagada; disabled é o caminho', async () => {
    // Garante que existe pelo menos um post apontando para a instalação.
    const { error: erroCriar } = await chamarRpcDevvit()
    expect(erroCriar).toBeNull()

    const { error } = await adminClient()
      .from('devvit_installations')
      .delete()
      .eq('id', instalacao)
    // FK sem cascade: o delete falha enquanto houver agendamentos/histórico.
    expect(error).not.toBeNull()
  })
})

describe('devvit_installations: RLS e escrita exclusiva do backend', () => {
  it('o usuário vê apenas as próprias instalações', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('devvit_installations')
      .select('id, owner_id')
    expect(data).not.toBeNull()
    for (const linha of data!) expect(linha.owner_id).toBe(userA.id)
  })

  it('o outro usuário não enxerga a instalação de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('devvit_installations')
      .select('id')
      .eq('id', instalacao)
    expect(data).toHaveLength(0)
  })

  it('authenticated não insere instalação', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('devvit_installations')
      .insert({
        owner_id: userA.id,
        subreddit_name: 'invadida',
        app_slug: 'qualquer',
      })
    expect(error).not.toBeNull()
  })

  it('authenticated não altera instalação', async () => {
    const { data, error } = await userClient(userA.accessToken)
      .from('devvit_installations')
      .update({ status: 'disabled' })
      .eq('id', instalacao)
      .select('id')
    // Sem grant de UPDATE o PostgREST devolve erro; com grant mas sem policy,
    // zero linhas. Os dois resultados significam "não alterou".
    if (!error) expect(data).toHaveLength(0)

    const { data: linha } = await adminClient()
      .from('devvit_installations')
      .select('status')
      .eq('id', instalacao)
      .single()
    expect(linha!.status).toBe('active')
  })
})

describe('colunas devvit_* são gerenciadas pelo sistema', () => {
  const COLUNAS_DEVVIT = [
    'publisher',
    'devvit_installation_id',
    'devvit_job_id',
    'devvit_sync_status',
    'devvit_sync_error',
  ]

  it('mesmo com grant acidental, o trigger recusa a alteração', async () => {
    const id = await criarPostDevvit()
    const colunas = COLUNAS_DEVVIT.join(', ')

    await withSql((db) =>
      db.query(
        `grant update (${colunas}) on public.scheduled_posts to authenticated`,
      ),
    )
    try {
      const { error } = await userClient(userA.accessToken)
        .from('scheduled_posts')
        .update({ devvit_sync_status: 'accepted' })
        .eq('id', id)
      expect(error).not.toBeNull()

      const { error: erroPublisher } = await userClient(userA.accessToken)
        .from('scheduled_posts')
        .update({ publisher: 'worker' })
        .eq('id', id)
      expect(erroPublisher).not.toBeNull()
    } finally {
      await withSql((db) =>
        db.query(
          `revoke update (${colunas}) on public.scheduled_posts from authenticated`,
        ),
      )
    }

    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select('publisher, devvit_sync_status')
      .eq('id', id)
      .single()
    expect(linha!.publisher).toBe('devvit')
    expect(linha!.devvit_sync_status).toBe('pending')
  })
})
