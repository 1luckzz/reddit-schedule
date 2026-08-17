import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { acquireQueueLock, releaseQueueLock } from './queue-lock'

let userA: { id: string; accessToken: string }
let conta: string
let sub: string

/**
 * Cria um job no estado em que o worker o deixaria se tivesse morrido:
 * `processing`, com lock antigo.
 */
async function jobPreso(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_id: sub,
      title: 'Job preso',
      url: 'https://exemplo.com/v',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() - 3600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
      status: 'processing',
      locked_by: 'worker-morto',
      locked_at: new Date(Date.now() - 3600_000).toISOString(),
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

const reap = (timeout = 300) =>
  adminClient().rpc('reap_stale_jobs', { p_timeout_seconds: timeout })

beforeAll(async () => {
  // A fila é global: sem isto, os arquivos que reivindicam jobs pegam as
  // linhas uns dos outros quando o Vitest os roda em paralelo.
  await acquireQueueLock()
  const stamp = Date.now()
  userA = await createTestUser(`rp-${stamp}@teste.local`)

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_rp_${stamp}`,
      username: 'conta_reaper',
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
      subreddit_fullname: `t5_rp_${stamp}`,
      name: 'com_reaper',
      display_name: 'Comunidade',
      url: '/r/com_reaper/',
    })
    .select('id')
    .single()
  sub = s!.id as string
})

beforeEach(async () => {
  await adminClient().from('scheduled_posts').delete().eq('owner_id', userA.id)
})

afterAll(async () => {
  // Limpar antes de liberar: o próximo arquivo não pode herdar jobs vencidos.
  await cleanupTestUsers([userA.id])
  await releaseQueueLock()
})

describe('reaper', () => {
  it('devolve à fila o job que comprovadamente não enviou', async () => {
    const id = await jobPreso({ submit_attempted_at: null })
    await reap()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status, locked_by, locked_at')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('scheduled')
    expect(data!.locked_by).toBeNull()
    expect(data!.locked_at).toBeNull()
  })

  it('manda para revisão o job cujo envio pode ter chegado', async () => {
    const id = await jobPreso({
      submit_attempted_at: new Date(Date.now() - 3500_000).toISOString(),
    })
    await reap()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status, review_reason')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('needs_review')
    expect(data!.review_reason).toBe('OUTCOME_UNKNOWN_WORKER_DIED')
  })

  it('NUNCA devolve à fila um job com envio tentado', async () => {
    const id = await jobPreso({
      submit_attempted_at: new Date(Date.now() - 3500_000).toISOString(),
    })
    await reap()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()
    expect(data!.status).not.toBe('scheduled')
  })

  it('não toca em job travado há pouco tempo', async () => {
    const id = await jobPreso({
      locked_at: new Date(Date.now() - 30_000).toISOString(),
      submit_attempted_at: null,
    })
    await reap(600)

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('processing')
  })

  it('não toca em job que já está em needs_review', async () => {
    const id = await jobPreso({ status: 'needs_review', locked_at: null })
    await reap()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('needs_review')
  })

  it('relata o que fez, separando por tipo e desfecho', async () => {
    await jobPreso({ submit_attempted_at: null })
    await jobPreso({
      submit_attempted_at: new Date(Date.now() - 3500_000).toISOString(),
    })

    const { data } = await reap()
    const desfechos = ((data ?? []) as { kind: string; outcome: string }[]).map(
      (r) => `${r.kind}:${r.outcome}`,
    )
    expect(desfechos).toContain('post:requeued')
    expect(desfechos).toContain('post:needs_review')
  })

  it('rodar o reaper duas vezes seguidas é inofensivo', async () => {
    const id = await jobPreso({ submit_attempted_at: null })
    await reap()
    const primeiro = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()

    const { data } = await reap()
    expect(data).toHaveLength(0)

    const segundo = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()
    expect(segundo.data!.status).toBe(primeiro.data!.status)
  })
})

// ---------------------------------------------------------------
// Heartbeat: um job vivo não pode ser roubado por espera longa
// ---------------------------------------------------------------
describe('renew_job_lock', () => {
  const TIMEOUT = 60

  const renovar = (id: string, worker: string, kind = 'post') =>
    adminClient().rpc('renew_job_lock', {
      p_kind: kind,
      p_job_id: id,
      p_worker_id: worker,
    })

  it('espera maior que o timeout do reaper NÃO libera o job, com heartbeat', async () => {
    // Cenário: worker-A reivindica e precisa esperar bem mais que o timeout.
    // Sem heartbeat o reaper devolveria o job à fila e worker-B publicaria o
    // mesmo conteúdo. Envelhecemos o lock em vez de dormir de verdade.
    const id = await jobPreso({
      locked_by: 'worker-A',
      submit_attempted_at: null,
    })

    for (const decorridos of [70, 140, 210]) {
      await adminClient()
        .from('scheduled_posts')
        .update({
          locked_at: new Date(Date.now() - decorridos * 1000).toISOString(),
        })
        .eq('id', id)

      // O heartbeat chega antes do reaper.
      const { data: renovou } = await renovar(id, 'worker-A')
      expect(renovou).toBe(true)

      const { data: colhidos } = await reap(TIMEOUT)
      expect(
        ((colhidos ?? []) as { job_id: string }[]).map((r) => r.job_id),
      ).not.toContain(id)

      // E o claim de outro worker não pode pegar este job.
      const { data: roubo } = await adminClient().rpc('claim_due_posts', {
        p_worker_id: 'worker-B',
        p_batch: 10,
      })
      expect(((roubo ?? []) as { id: string }[]).map((r) => r.id)).not.toContain(
        id,
      )
    }

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status, locked_by')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('processing')
    expect(data!.locked_by).toBe('worker-A')
  })

  it('CONTRAPROVA: sem heartbeat, a mesma espera perde o job', async () => {
    // Este teste existe para provar que o anterior não passa por acidente. Se
    // o reaper não recuperasse jobs vencidos, o primeiro nada provaria.
    const id = await jobPreso({
      locked_by: 'worker-A',
      submit_attempted_at: null,
    })
    await adminClient()
      .from('scheduled_posts')
      .update({ locked_at: new Date(Date.now() - 70_000).toISOString() })
      .eq('id', id)

    await reap(TIMEOUT)

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('scheduled')
  })

  it('um worker não renova o lock de outro', async () => {
    const id = await jobPreso({ locked_by: 'worker-A' })
    const { data } = await renovar(id, 'worker-B')
    expect(data).toBe(false)
  })

  it('renovar um job que já saiu de processing retorna falso', async () => {
    // É assim que o worker descobre que perdeu a corrida.
    const id = await jobPreso({
      status: 'scheduled',
      locked_by: null,
      locked_at: null,
    })
    const { data } = await renovar(id, 'worker-A')
    expect(data).toBe(false)
  })

  it('a renovação de fato adia o lock, não apenas retorna true', async () => {
    const id = await jobPreso({
      locked_by: 'worker-A',
      locked_at: new Date(Date.now() - 500_000).toISOString(),
      submit_attempted_at: null,
    })
    await renovar(id, 'worker-A')

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('locked_at')
      .eq('id', id)
      .single()
    expect(Date.now() - new Date(data!.locked_at as string).getTime())
      .toBeLessThan(5_000)
  })

  it('kind desconhecido é erro, não silêncio', async () => {
    const id = await jobPreso({ locked_by: 'worker-A' })
    const { error } = await renovar(id, 'worker-A', 'inventado')
    expect(error).not.toBeNull()
  })

  it('renova comentário também', async () => {
    const post = await jobPreso({
      status: 'published',
      locked_at: null,
      locked_by: null,
      reddit_fullname: `t3_${Math.random().toString(36).slice(2, 10)}`,
      published_at: new Date().toISOString(),
    })
    const { data: com, error } = await adminClient()
      .from('scheduled_comments')
      .insert({
        owner_id: userA.id,
        scheduled_post_id: post,
        reddit_account_id: conta,
        body: 'comentário',
        mode: 'absolute',
        status: 'processing',
        locked_by: 'worker-A',
        locked_at: new Date(Date.now() - 500_000).toISOString(),
        scheduled_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw error

    const { data } = await renovar(com!.id as string, 'worker-A', 'comment')
    expect(data).toBe(true)
  })
})
