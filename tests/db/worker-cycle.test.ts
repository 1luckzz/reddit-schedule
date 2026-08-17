import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { MockAgent } from 'undici'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import {
  criarJob,
  isolarOrcamento,
  lerJob,
  montarCenario,
  type Cenario,
} from '../worker/post-job-helpers'
import { runCycle } from '../../worker/index'

let userA: { id: string; accessToken: string }
let cenario: Cenario
let agent: MockAgent
let hashOrcamento: string
let clientId: string

const reqPath = (p: string) => p.includes('post_requirements')
const submitPath = (p: string) => p.startsWith('/api/submit')
const pool = () => agent.get('https://oauth.reddit.com')

/**
 * Cada submissão devolve um identificador diferente, como o Reddit faz.
 *
 * Reutilizar um id fixo colidiria com o índice único
 * (reddit_account_id, reddit_post_id) — que existe justamente para impedir
 * registrar a mesma publicação duas vezes na mesma conta.
 */
function sucessoSubmit() {
  const id = `wc${Math.random().toString(36).slice(2, 10)}`
  return {
    json: {
      errors: [],
      data: { id, name: `t3_${id}`, url: `https://reddit.com/r/x/${id}/` },
    },
  }
}

beforeAll(async () => {
  await isolarOrcamento('wc')
  clientId = process.env.REDDIT_CLIENT_ID!
  hashOrcamento = createHash('sha256').update(clientId).digest('hex')

  process.env.WORKER_ID = 'worker-ciclo'
  process.env.WORKER_INTERVAL_SECONDS = '5'
  process.env.WORKER_REAPER_TIMEOUT_SECONDS = '600'
  process.env.WORKER_BATCH_SIZE = '10'

  userA = await createTestUser(`wc-${Date.now()}@teste.local`)
  cenario = await montarCenario(userA.id, 'wc')
})

beforeEach(async () => {
  // Refixa o client_id a cada teste. `clientHash()` lê o ambiente na hora da
  // chamada, e o processo do Vitest é compartilhado entre arquivos: um
  // arquivo anterior que tenha mexido em REDDIT_CLIENT_ID faria o ciclo ler
  // uma linha de orçamento diferente da que este teste pausa.
  process.env.REDDIT_CLIENT_ID = clientId

  // A fila do worker é global: `runCycle` reivindica TODA publicação vencida,
  // não as de um dono. Um teste do ciclo precisa portanto controlar a fila
  // inteira — restos de arquivos anteriores seriam processados junto e
  // consumiriam os intercepts destinados aos jobs daqui.
  //
  // Apagar é seguro: os arquivos de teste removem seus usuários no `afterAll`,
  // então o que sobra neste ponto é resíduo, não trabalho de alguém.
  await adminClient()
    .from('scheduled_posts')
    .delete()
    .in('status', ['scheduled', 'processing'])
  await adminClient().from('scheduled_posts').delete().eq('owner_id', userA.id)
  await adminClient()
    .from('scheduled_comments')
    .delete()
    .in('status', ['scheduled', 'processing'])
  await liberarOrcamento()
})

afterEach(async () => {
  await agent?.close()
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

function mock() {
  agent = new MockAgent()
  agent.disableNetConnect()
  return agent
}

async function pausarOrcamento() {
  await adminClient()
    .from('reddit_api_budget')
    .update({
      remaining: 0,
      paused_until: new Date(Date.now() + 600_000).toISOString(),
    })
    .eq('client_id_hash', hashOrcamento)
}

async function liberarOrcamento() {
  await adminClient()
    .from('reddit_api_budget')
    .update({ remaining: 500, paused_until: null, reserved: 0 })
    .eq('client_id_hash', hashOrcamento)
}

/** Job pronto para o claim: `scheduled` e vencido. */
const jobNaFila = (overrides: Record<string, unknown> = {}) =>
  criarJob(cenario, {
    status: 'scheduled',
    locked_by: null,
    locked_at: null,
    ...overrides,
  })

describe('runCycle', () => {
  it('ciclo sem jobs devolve relatório zerado e não chama a API', async () => {
    mock() // nenhum intercept: qualquer chamada seria recusada
    const r = await runCycle({ dispatcher: agent })

    expect(r.posts).toEqual({})
    expect(r.comments).toEqual({})
    expect(r.pausedForBudget).toBe(false)
  })

  it('publica um job vencido e relata a contagem', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, () => sucessoSubmit())

    const j = await jobNaFila()
    const r = await runCycle({ dispatcher: agent })

    expect(r.posts.published).toBe(1)
    expect((await lerJob(j.id)).status).toBe('published')
  })

  it('roda o reaper antes do claim: job preso volta e é processado', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, () => sucessoSubmit())

    // Job que um worker anterior deixou preso, sem ter enviado nada.
    const j = await criarJob(cenario, {
      status: 'processing',
      locked_by: 'worker-morto',
      locked_at: new Date(Date.now() - 3600_000).toISOString(),
      submit_attempted_at: null,
    })

    const r = await runCycle({ dispatcher: agent })

    const depois = await lerJob(j.id)
    const ctx = `relatorio=${JSON.stringify(r)} job=${JSON.stringify({
      status: depois.status,
      locked_by: depois.locked_by,
      error_code: depois.error_code,
      error_message: depois.error_message,
      submit_attempted_at: depois.submit_attempted_at,
    })}`
    expect(r.reaped, ctx).toBeGreaterThan(0)
    // Se o claim viesse antes do reaper, o job ainda estaria em processing.
    expect(depois.status, ctx).toBe('published')
  })

  it('erro em um job não impede o processamento do próximo', async () => {
    mock()
    // Dois jobs; o primeiro falha com 403, o segundo publica.
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {}).times(2)
    pool().intercept({ path: submitPath, method: 'POST' }).reply(403, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, () => sucessoSubmit())

    await jobNaFila({ scheduled_at: new Date(Date.now() - 7200_000).toISOString() })
    await jobNaFila({ scheduled_at: new Date(Date.now() - 60_000).toISOString() })

    const r = await runCycle({ dispatcher: agent })

    expect(r.posts.failed).toBe(1)
    expect(r.posts.published).toBe(1)
  })
})

describe('o ciclo não segura jobs enquanto espera', () => {
  it('orçamento pausado: NENHUM job sai de scheduled', async () => {
    // A prova de que a checagem vem antes do claim. Se viesse depois, os jobs
    // ficariam em processing durante toda a pausa — e o reaper de outra
    // instância os arrancaria.
    mock()
    const a = await jobNaFila()
    const b = await jobNaFila()
    await pausarOrcamento()

    const { data: orcamento } = await adminClient()
      .from('reddit_api_budget')
      .select('*')
      .eq('client_id_hash', hashOrcamento)
      .maybeSingle()

    const r = await runCycle({ dispatcher: agent })

    // O contexto vai na mensagem: uma falha intermitente aqui precisa dizer
    // qual era o estado do orçamento, senão vira caça ao fantasma.
    const ctx = `orcamento=${JSON.stringify(orcamento)} relatorio=${JSON.stringify(r)} cid=${process.env.REDDIT_CLIENT_ID}`
    expect(r.pausedForBudget, ctx).toBe(true)
    for (const j of [a, b]) {
      const depois = await lerJob(j.id)
      expect(depois.status, ctx).toBe('scheduled')
      expect(depois.locked_by, ctx).toBeNull()
    }
  })

  it('orçamento esgota no meio do lote: o restante volta para a fila', async () => {
    mock()
    // A pausa é disparada na PRIMEIRA requisição do primeiro job, não na
    // última. Escrever no banco é assíncrono, e disparar aqui dá à escrita
    // uma janela feita de trabalho real — o restante da requisição, a
    // submissão inteira e várias gravações — em vez de uma corrida com o
    // próximo passo do ciclo.
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, () => {
        void pausarOrcamento()
        return {}
      })
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, () => sucessoSubmit())

    const primeiro = await jobNaFila({
      scheduled_at: new Date(Date.now() - 7200_000).toISOString(),
    })
    const outros = [
      await jobNaFila({
        scheduled_at: new Date(Date.now() - 3600_000).toISOString(),
      }),
      await jobNaFila({
        scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]

    const r = await runCycle({ dispatcher: agent })

    expect(r.pausedForBudget).toBe(true)

    // De propósito, NÃO se afirma nada sobre o desfecho do primeiro job.
    // A pausa é escrita de forma assíncrona pelo interceptor, então ele pode
    // publicar ou já ser recusado pelo orçamento — e a propriedade sob teste
    // vale nos dois casos. Amarrar o teste a um desses caminhos o tornaria
    // intermitente sem provar nada a mais.
    const depoisPrimeiro = await lerJob(primeiro.id)
    expect(depoisPrimeiro.locked_by).toBeNull()

    // O que importa: os jobs que o ciclo não chegou a processar não ficam
    // presos em `processing` até a pausa acabar.
    for (const j of outros) {
      const depois = await lerJob(j.id)
      expect(depois.status).toBe('scheduled')
      expect(depois.locked_by).toBeNull()
      // Devolver só é seguro porque nenhum chegou a tentar enviar.
      expect(depois.submit_attempted_at).toBeNull()
    }
  })
})

describe('heartbeat: job demorado não é roubado', () => {
  it('espera maior que o timeout do reaper NÃO libera o job', async () => {
    // O caso irredutível: um único job demora mais que o timeout. Sem o
    // heartbeat, o reaper de outra instância o recuperaria e o mesmo conteúdo
    // sairia duas vezes.
    process.env.WORKER_REAPER_TIMEOUT_SECONDS = '2'
    process.env.WORKER_INTERVAL_SECONDS = '1'

    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      // Cinco segundos: 2,5x o timeout do reaper.
      .reply(200, () => sucessoSubmit())
      .delay(5000)

    const j = await jobNaFila()
    const ciclo = runCycle({ dispatcher: agent })

    // Enquanto o ciclo roda, um segundo worker tenta reivindicar e o reaper
    // tenta recuperar. Nenhum dos dois pode conseguir.
    await new Promise((r) => setTimeout(r, 3500))

    const { data: colhidos } = await adminClient().rpc('reap_stale_jobs', {
      p_timeout_seconds: 2,
    })
    expect(
      ((colhidos ?? []) as { job_id: string }[]).map((r) => r.job_id),
    ).not.toContain(j.id)

    const { data: roubo } = await adminClient().rpc('claim_due_posts', {
      p_worker_id: 'worker-intruso',
      p_batch: 10,
    })
    expect(((roubo ?? []) as { id: string }[]).map((r) => r.id)).not.toContain(
      j.id,
    )

    await ciclo

    // E o job terminou normalmente, uma vez só.
    expect((await lerJob(j.id)).status).toBe('published')
    const { data: logs } = await adminClient()
      .from('execution_logs')
      .select('id')
      .eq('scheduled_post_id', j.id)
      .eq('action', 'submit_post')
      .eq('outcome', 'success')
    expect(logs).toHaveLength(1)

    process.env.WORKER_REAPER_TIMEOUT_SECONDS = '600'
    process.env.WORKER_INTERVAL_SECONDS = '5'
  }, 30_000)
})
