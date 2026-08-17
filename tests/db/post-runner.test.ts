import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { acquireQueueLock, releaseQueueLock } from './queue-lock'
import {
  criarJob,
  isolarOrcamento,
  lerJob,
  montarCenario,
  rodar,
  type Cenario,
} from '../worker/post-job-helpers'

let userA: { id: string; accessToken: string }
let cenario: Cenario
let agent: MockAgent

const reqPath = (p: string) => p.includes('post_requirements')
const submitPath = (p: string) => p.startsWith('/api/submit')

const pool = () => agent.get('https://oauth.reddit.com')

beforeAll(async () => {
  // Os jobs deste arquivo ficam em `processing`; um reaper de outro arquivo
  // rodando em paralelo os arrancaria no meio da execução.
  await acquireQueueLock()
  await isolarOrcamento('pr')
  userA = await createTestUser(`pr-${Date.now()}@teste.local`)
  cenario = await montarCenario(userA.id, 'pr')
})

afterEach(async () => {
  await agent?.close()
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
  await releaseQueueLock()
})

/** MockAgent limpo por teste: intercepts não vazam entre casos. */
function mock() {
  agent = new MockAgent()
  agent.disableNetConnect()
  return agent
}

const job = (overrides: Record<string, unknown> = {}) =>
  criarJob(cenario, overrides)

const sucessoSubmit = {
  json: {
    errors: [],
    data: {
      id: 'abc123',
      name: 't3_abc123',
      url: 'https://www.reddit.com/r/com_pr/comments/abc123/titulo/',
    },
  },
}

describe('runPost — caminho feliz', () => {
  it('publica e grava identificadores', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, sucessoSubmit)

    const j = await job()
    const r = await rodar(j, { dispatcher: agent })
    expect(r.outcome).toBe('published')

    const depois = await lerJob(j.id)
    expect(depois.status).toBe('published')
    expect(depois.reddit_post_id).toBe('abc123')
    expect(depois.reddit_fullname).toBe('t3_abc123')
    expect(depois.published_at).not.toBeNull()
    expect(depois.locked_by).toBeNull()
    expect(depois.locked_at).toBeNull()
  })

  it('registra o espaçamento da conta', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, sucessoSubmit)

    await rodar(await job(), { dispatcher: agent })

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('last_submit_at')
      .eq('id', cenario.contaId)
      .single()
    expect(data!.last_submit_at).not.toBeNull()
  })

  it('materializa o horário dos comentários pendentes', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, sucessoSubmit)

    const j = await job()
    const { data: com } = await adminClient()
      .from('scheduled_comments')
      .insert({
        owner_id: userA.id,
        scheduled_post_id: j.id,
        reddit_account_id: cenario.contaId,
        body: 'primeiro comentário',
        mode: 'delay',
        delay_minutes: 10,
        status: 'scheduled',
      })
      .select('id')
      .single()

    await rodar(j, { dispatcher: agent })

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('scheduled_at')
      .eq('id', com!.id)
      .single()
    expect(data!.scheduled_at).not.toBeNull()
  })

  it('grava log de sucesso', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, sucessoSubmit)

    const j = await job()
    await rodar(j, { dispatcher: agent })

    const { data } = await adminClient()
      .from('execution_logs')
      .select('outcome, action')
      .eq('scheduled_post_id', j.id)
    expect(data!.some((l) => l.outcome === 'success')).toBe(true)
  })
})

describe('runPost — resultado desconhecido', () => {
  it('5xx na submissão manda para needs_review, sem retry', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(503, {})

    const j = await job()
    const r = await rodar(j, { dispatcher: agent })
    expect(r.outcome).toBe('needs_review')

    const depois = await lerJob(j.id)
    expect(depois.status).toBe('needs_review')
    expect(depois.retry_count).toBe(0)
    expect(depois.next_attempt_at).toBeNull()
    expect(depois.review_reason).toBeTruthy()
  })

  it('PRESERVA submit_attempted_at: é o registro de que pode ter saído', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(502, {})

    const j = await job()
    await rodar(j, { dispatcher: agent })

    expect((await lerJob(j.id)).submit_attempted_at).not.toBeNull()
  })

  it('queda de conexão após o envio manda para needs_review', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

    const j = await job()
    await rodar(j, { dispatcher: agent })

    expect((await lerJob(j.id)).status).toBe('needs_review')
  })

  it('registra log com outcome unknown', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(503, {})

    const j = await job()
    await rodar(j, { dispatcher: agent })

    const { data } = await adminClient()
      .from('execution_logs')
      .select('outcome')
      .eq('scheduled_post_id', j.id)
    expect(data!.some((l) => l.outcome === 'unknown')).toBe(true)
  })
})

describe('runPost — retentativa', () => {
  it('429 volta para a fila com backoff e limpa submit_attempted_at', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(429, {})

    const j = await job()
    const r = await rodar(j, { dispatcher: agent })
    expect(r.outcome).toBe('retry')

    const depois = await lerJob(j.id)
    expect(depois.status).toBe('scheduled')
    expect(depois.retry_count).toBe(1)
    expect(depois.next_attempt_at).not.toBeNull()
    // Só é seguro limpar porque safeToRetryEffect afirma que nada saiu.
    expect(depois.submit_attempted_at).toBeNull()
    expect(depois.locked_by).toBeNull()
  })

  it('depois de MAX_RETRIES vira failed em vez de insistir', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(429, {})

    const j = await job({ retry_count: 3 })
    const r = await rodar(j, { dispatcher: agent })
    expect(r.outcome).toBe('failed')
    expect((await lerJob(j.id)).status).toBe('failed')
  })
})

describe('runPost — erro terminal', () => {
  it('403 na submissão vira failed imediatamente', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(403, {})

    const j = await job()
    const r = await rodar(j, { dispatcher: agent })
    expect(r.outcome).toBe('failed')

    const depois = await lerJob(j.id)
    expect(depois.status).toBe('failed')
    expect(depois.retry_count).toBe(0)
  })

  it('200 com json.errors vira failed com a mensagem do Reddit', async () => {
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, {
        json: { errors: [['SUBREDDIT_NOTALLOWED', 'não permitido', 'sr']] },
      })

    const j = await job()
    await rodar(j, { dispatcher: agent })

    const depois = await lerJob(j.id)
    expect(depois.status).toBe('failed')
    expect(depois.error_message).toMatch(/não permitido/i)
  })
})

describe('runPost — validação antes de enviar', () => {
  it('falha ao ler requisitos NÃO publica', async () => {
    // Herdado do Plano 3: indisponibilidade não vira permissão.
    mock()
    pool().intercept({ path: reqPath, method: 'GET' }).reply(403, {})
    // Nenhum intercept de submit: se publicasse, o MockAgent recusaria.

    const j = await job()
    await rodar(j, { dispatcher: agent })

    const depois = await lerJob(j.id)
    expect(depois.status).not.toBe('published')
    expect(depois.reddit_post_id).toBeNull()
    // E nem chegou ao ponto sem volta.
    expect(depois.submit_attempted_at).toBeNull()
  })

  it('requisito violado desde o agendamento vira falha, não publicação', async () => {
    // A comunidade passou a exigir flair depois que o post foi agendado.
    mock()
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { is_flair_required: true })

    const j = await job({ flair_id: null })
    await rodar(j, { dispatcher: agent })

    const depois = await lerJob(j.id)
    expect(depois.status).toBe('failed')
    expect(depois.error_message).toMatch(/flair/i)
  })

  it('conta desconectada no meio do caminho não publica', async () => {
    mock()
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', cenario.contaId)

    const j = await job()
    await rodar(j, { dispatcher: agent })

    const depois = await lerJob(j.id)
    expect(depois.status).not.toBe('published')

    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'connected' })
      .eq('id', cenario.contaId)
  })

  it('comunidade de outra conta é recusada antes de qualquer chamada', async () => {
    // As FKs compostas já impedem isto; o teste prova a defesa em profundidade
    // do lado do worker, montando o cenário por baixo delas.
    mock()
    const outro = await montarCenario(userA.id, 'pr2')
    const j = await job()
    const adulterado = { ...j, subreddit_id: outro.subredditId }

    await rodar(adulterado, { dispatcher: agent })

    const depois = await lerJob(j.id)
    expect(depois.status).toBe('failed')
    expect(depois.submit_attempted_at).toBeNull()
  })
})
