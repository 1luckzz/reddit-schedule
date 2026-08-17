import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let conta: string
let sub: string

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
      // No passado: pronto para publicar.
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

const claim = (workerId: string, batch = 10) =>
  adminClient().rpc('claim_due_posts', {
    p_worker_id: workerId,
    p_batch: batch,
  })

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`cl-${stamp}@teste.local`)

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_cl_${stamp}`,
      username: 'conta_claim',
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
      subreddit_fullname: `t5_cl_${stamp}`,
      name: 'com_claim',
      display_name: 'Comunidade',
      url: '/r/com_claim/',
    })
    .select('id')
    .single()
  sub = s!.id as string
})

beforeEach(async () => {
  // Cada teste começa sem jobs pendentes.
  await adminClient().from('scheduled_posts').delete().eq('owner_id', userA.id)
  await adminClient()
    .from('reddit_accounts')
    .update({
      last_submit_at: null,
      min_interval_seconds: 0,
      status: 'connected',
    })
    .eq('id', conta)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('claim_due_posts', () => {
  it('pega job vencido e marca como processing', async () => {
    const id = await criarPost()
    const { data, error } = await claim('worker-1')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(id)

    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select('status, locked_by, locked_at')
      .eq('id', id)
      .single()
    expect(linha!.status).toBe('processing')
    expect(linha!.locked_by).toBe('worker-1')
    expect(linha!.locked_at).not.toBeNull()
  })

  it('não pega job com horário futuro', async () => {
    await criarPost({
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    const { data } = await claim('worker-1')
    expect(data).toHaveLength(0)
  })

  it('não pega job em backoff', async () => {
    await criarPost({
      next_attempt_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    const { data } = await claim('worker-1')
    expect(data).toHaveLength(0)
  })

  it('pega job cujo backoff já venceu', async () => {
    await criarPost({
      retry_count: 2,
      next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    })
    const { data } = await claim('worker-1')
    expect(data).toHaveLength(1)
  })

  it('não pega job que não está em scheduled', async () => {
    for (const status of [
      'draft',
      'processing',
      'published',
      'failed',
      'cancelled',
      'needs_review',
    ]) {
      await adminClient()
        .from('scheduled_posts')
        .delete()
        .eq('owner_id', userA.id)
      await criarPost({ status })
      const { data } = await claim('worker-1')
      expect(data, `status ${status}`).toHaveLength(0)
    }
  })

  it('respeita o batch', async () => {
    await criarPost()
    await criarPost()
    await criarPost()
    const { data } = await claim('worker-1', 2)
    expect(data).toHaveLength(2)
  })

  it('entrega os mais antigos primeiro', async () => {
    const velho = await criarPost({
      scheduled_at: new Date(Date.now() - 7200_000).toISOString(),
    })
    await criarPost({
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    })

    const { data } = await claim('worker-1', 1)
    expect(data![0].id).toBe(velho)
  })

  it('CORRIDA: dois workers nunca pegam o mesmo job', async () => {
    // A garantia central: at-most-one concurrent claim.
    const ids = []
    for (let i = 0; i < 6; i++) ids.push(await criarPost())

    const [a, b] = await Promise.all([
      claim('worker-1', 6),
      claim('worker-2', 6),
    ])

    const pegos = [
      ...(a.data ?? []).map((r: { id: string }) => r.id),
      ...(b.data ?? []).map((r: { id: string }) => r.id),
    ]
    expect(pegos).toHaveLength(6)
    expect(new Set(pegos).size).toBe(6)
  })

  it('respeita o espaçamento mínimo da conta', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({
        min_interval_seconds: 300,
        last_submit_at: new Date().toISOString(),
      })
      .eq('id', conta)

    await criarPost()
    const { data } = await claim('worker-1')
    expect(data).toHaveLength(0)
  })

  it('libera a conta quando o espaçamento já passou', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({
        min_interval_seconds: 60,
        last_submit_at: new Date(Date.now() - 120_000).toISOString(),
      })
      .eq('id', conta)

    await criarPost()
    const { data } = await claim('worker-1')
    expect(data).toHaveLength(1)
  })

  it('não pega job de conta desconectada', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', conta)
    await criarPost()

    const { data } = await claim('worker-1')
    expect(data).toHaveLength(0)
  })

  it('as cinco funções existem e são SECURITY DEFINER com search_path fixo', async () => {
    // Sem esta asserção o teste de privilégios abaixo passaria mesmo se as
    // funções nunca tivessem sido criadas — zero linhas por ausência, não por
    // proteção.
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('claim_due_posts', 'claim_due_comments',
                             'reap_stale_jobs', 'renew_job_lock',
                             'materialize_comment_schedule')
         order by p.proname`,
      ),
    )
    expect(rows.map((r) => r.proname)).toEqual([
      'claim_due_comments',
      'claim_due_posts',
      'materialize_comment_schedule',
      'reap_stale_jobs',
      'renew_job_lock',
    ])
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} precisa ser security definer`).toBe(
        true,
      )
      // proconfig é um array de "chave=valor"; o valor vazio é o esperado.
      expect(r.proconfig, `${r.proname} precisa fixar search_path`).toContain(
        'search_path=""',
      )
    }
  })

  it('a função não é chamável por anon nem authenticated', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, r.rolname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral (values ('anon'), ('authenticated')) as r(rolname)
         where n.nspname = 'public'
           and p.proname in ('claim_due_posts', 'claim_due_comments',
                             'reap_stale_jobs', 'renew_job_lock',
                             'materialize_comment_schedule')
           and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('mas service_role tem EXECUTE em todas: senão o worker não roda', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('claim_due_posts', 'claim_due_comments',
                             'reap_stale_jobs', 'renew_job_lock',
                             'materialize_comment_schedule')
           and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(5)
  })
})

describe('claim_due_comments', () => {
  async function criarComentario(
    postId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const { data, error } = await adminClient()
      .from('scheduled_comments')
      .insert({
        owner_id: userA.id,
        scheduled_post_id: postId,
        reddit_account_id: conta,
        body: 'comentário de teste',
        mode: 'absolute',
        scheduled_at: new Date(Date.now() - 30_000).toISOString(),
        status: 'scheduled',
        ...overrides,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id as string
  }

  /** Post pai já publicado: o único estado em que o comentário é elegível. */
  async function postPublicado() {
    return criarPost({
      status: 'published',
      reddit_post_id: `abc${Math.random().toString(36).slice(2, 10)}`,
      reddit_fullname: `t3_${Math.random().toString(36).slice(2, 10)}`,
      published_at: new Date(Date.now() - 60_000).toISOString(),
    })
  }

  const claimCom = (workerId: string, batch = 10) =>
    adminClient().rpc('claim_due_comments', {
      p_worker_id: workerId,
      p_batch: batch,
    })

  it('pega comentário de post já publicado', async () => {
    const post = await postPublicado()
    const id = await criarComentario(post)

    const { data } = await claimCom('worker-1')
    expect((data ?? []).map((r: { id: string }) => r.id)).toContain(id)
  })

  it('NÃO pega comentário cujo post ainda não publicou', async () => {
    // A regra que impede comentar em um post inexistente.
    const post = await criarPost({ status: 'processing' })
    await criarComentario(post)

    const { data } = await claimCom('worker-1')
    expect(data).toHaveLength(0)
  })

  it('NÃO pega comentário de post publicado sem fullname', async () => {
    // Sem o fullname não há em que comentar, mesmo o post constando publicado.
    const post = await criarPost({
      status: 'published',
      reddit_fullname: null,
      published_at: new Date().toISOString(),
    })
    await criarComentario(post)

    const { data } = await claimCom('worker-1')
    expect(data).toHaveLength(0)
  })

  it('não pega comentário sem horário materializado', async () => {
    const post = await postPublicado()
    await criarComentario(post, {
      mode: 'immediate',
      scheduled_at: null,
      delay_minutes: null,
    })

    const { data } = await claimCom('worker-1')
    expect(data).toHaveLength(0)
  })

  it('pega comentário com horário absoluto já vencido', async () => {
    // O usuário pediu "às 15h"; publicar às 15h30 não torna o comentário
    // indesejado. Ele fica elegível imediatamente, não é descartado.
    const post = await postPublicado()
    const id = await criarComentario(post, {
      scheduled_at: new Date(Date.now() - 86_400_000).toISOString(),
    })

    const { data } = await claimCom('worker-1')
    expect((data ?? []).map((r: { id: string }) => r.id)).toContain(id)
  })

  it('não pega comentário de conta desconectada', async () => {
    const post = await postPublicado()
    await criarComentario(post)
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', conta)

    const { data } = await claimCom('worker-1')
    expect(data).toHaveLength(0)
  })

  it('CORRIDA: dois workers nunca pegam o mesmo comentário', async () => {
    const post = await postPublicado()
    for (let i = 0; i < 4; i++) await criarComentario(post)

    const [a, b] = await Promise.all([
      claimCom('worker-1', 4),
      claimCom('worker-2', 4),
    ])
    const pegos = [
      ...(a.data ?? []).map((r: { id: string }) => r.id),
      ...(b.data ?? []).map((r: { id: string }) => r.id),
    ]
    expect(pegos).toHaveLength(4)
    expect(new Set(pegos).size).toBe(4)
  })
})

describe('materialize_comment_schedule', () => {
  const publicadoEm = new Date('2026-09-01T12:00:00.000Z')

  async function cenario(overrides: Record<string, unknown>) {
    const post = await criarPost({
      status: 'published',
      reddit_fullname: `t3_${Math.random().toString(36).slice(2, 10)}`,
      published_at: publicadoEm.toISOString(),
    })
    const { data, error } = await adminClient()
      .from('scheduled_comments')
      .insert({
        owner_id: userA.id,
        scheduled_post_id: post,
        reddit_account_id: conta,
        body: 'comentário',
        status: 'scheduled',
        ...overrides,
      })
      .select('id')
      .single()
    if (error) throw error

    await adminClient().rpc('materialize_comment_schedule', {
      p_post_id: post,
      p_published_at: publicadoEm.toISOString(),
    })

    const { data: depois } = await adminClient()
      .from('scheduled_comments')
      .select('scheduled_at')
      .eq('id', data!.id)
      .single()
    return depois!.scheduled_at as string | null
  }

  it('modo immediate recebe o horário exato da publicação', async () => {
    const at = await cenario({ mode: 'immediate' })
    expect(new Date(at!).toISOString()).toBe(publicadoEm.toISOString())
  })

  it('modo delay soma os minutos ao horário real da publicação', async () => {
    const at = await cenario({ mode: 'delay', delay_minutes: 45 })
    expect(new Date(at!).toISOString()).toBe('2026-09-01T12:45:00.000Z')
  })

  it('modo absolute NÃO é alterado', async () => {
    // O usuário escolheu um horário fixo; a publicação não o desloca.
    const escolhido = '2026-09-02T09:30:00.000Z'
    const at = await cenario({ mode: 'absolute', scheduled_at: escolhido })
    expect(new Date(at!).toISOString()).toBe(escolhido)
  })

  it('não toca em comentário que já saiu de scheduled', async () => {
    const at = await cenario({ mode: 'immediate', status: 'cancelled' })
    expect(at).toBeNull()
  })
})
