import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { acquireQueueLock, releaseQueueLock } from './queue-lock'
import {
  criarJob,
  isolarOrcamento,
  montarCenario,
  type Cenario,
} from '../worker/post-job-helpers'
import { runComment, type CommentJob } from '../../worker/comment-runner'

let userA: { id: string; accessToken: string }
let cenario: Cenario
let agent: MockAgent

const commentPath = (p: string) => p.startsWith('/api/comment')
const pool = () => agent.get('https://oauth.reddit.com')

beforeAll(async () => {
  await acquireQueueLock()
  await isolarOrcamento('cr')
  userA = await createTestUser(`cr-${Date.now()}@teste.local`)
  cenario = await montarCenario(userA.id, 'cr')
})

afterEach(async () => {
  await agent?.close()
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
  await releaseQueueLock()
})

function mock() {
  agent = new MockAgent()
  agent.disableNetConnect()
  return agent
}

const sucesso = {
  json: {
    errors: [],
    data: {
      things: [
        {
          kind: 't1',
          data: {
            id: 'cmt1',
            name: 't1_cmt1',
            permalink: '/r/com_cr/comments/abc/titulo/cmt1/',
          },
        },
      ],
    },
  },
}

/** Post pai publicado, o único estado em que o comentário faz sentido. */
async function postPublicado(overrides: Record<string, unknown> = {}) {
  return criarJob(cenario, {
    status: 'published',
    reddit_post_id: `p${Math.random().toString(36).slice(2, 10)}`,
    reddit_fullname: `t3_${Math.random().toString(36).slice(2, 10)}`,
    published_at: new Date(Date.now() - 60_000).toISOString(),
    locked_by: null,
    locked_at: null,
    ...overrides,
  })
}

async function criarComentario(
  postId: string,
  overrides: Record<string, unknown> = {},
): Promise<CommentJob> {
  const { data, error } = await adminClient()
    .from('scheduled_comments')
    .insert({
      owner_id: userA.id,
      scheduled_post_id: postId,
      reddit_account_id: cenario.contaId,
      body: 'meu comentário automático',
      mode: 'absolute',
      scheduled_at: new Date(Date.now() - 30_000).toISOString(),
      // Já reivindicado.
      status: 'processing',
      locked_by: 'worker-teste',
      locked_at: new Date().toISOString(),
      ...overrides,
    })
    .select(
      'id, owner_id, scheduled_post_id, reddit_account_id, body, retry_count',
    )
    .single()
  if (error) throw error
  return data as unknown as CommentJob
}

async function lerComentario(id: string) {
  const { data, error } = await adminClient()
    .from('scheduled_comments')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data!
}

describe('runComment — caminho feliz', () => {
  it('publica o comentário e grava id e permalink', async () => {
    mock()
    pool().intercept({ path: commentPath, method: 'POST' }).reply(200, sucesso)

    const post = await postPublicado()
    const c = await criarComentario(post.id)
    const r = await runComment(c, { dispatcher: agent })
    expect(r.outcome).toBe('published')

    const depois = await lerComentario(c.id)
    expect(depois.status).toBe('published')
    expect(depois.reddit_comment_id).toBe('cmt1')
    expect(depois.reddit_permalink).toBe('/r/com_cr/comments/abc/titulo/cmt1/')
    expect(depois.published_at).not.toBeNull()
    expect(depois.locked_by).toBeNull()
  })

  it('comenta no fullname do post pai', async () => {
    mock()
    let corpo = ''
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, (opts: { body?: unknown }) => {
        corpo = String(opts.body)
        return sucesso
      })

    const post = await postPublicado()
    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('reddit_fullname')
      .eq('id', post.id)
      .single()

    const c = await criarComentario(post.id)
    await runComment(c, { dispatcher: agent })

    expect(corpo).toContain(`thing_id=${data!.reddit_fullname}`)
  })

  it('registra log com o scheduled_comment_id preenchido', async () => {
    mock()
    pool().intercept({ path: commentPath, method: 'POST' }).reply(200, sucesso)

    const post = await postPublicado()
    const c = await criarComentario(post.id)
    await runComment(c, { dispatcher: agent })

    const { data } = await adminClient()
      .from('execution_logs')
      .select('outcome, action, scheduled_comment_id')
      .eq('scheduled_comment_id', c.id)
    expect(data!.length).toBeGreaterThan(0)
    expect(data![0].action).toBe('submit_comment')
  })
})

describe('runComment — desfechos', () => {
  it('5xx vira needs_review sem retry e preserva submit_attempted_at', async () => {
    mock()
    pool().intercept({ path: commentPath, method: 'POST' }).reply(503, {})

    const post = await postPublicado()
    const c = await criarComentario(post.id)
    const r = await runComment(c, { dispatcher: agent })
    expect(r.outcome).toBe('needs_review')

    const depois = await lerComentario(c.id)
    expect(depois.status).toBe('needs_review')
    expect(depois.next_attempt_at).toBeNull()
    expect(depois.submit_attempted_at).not.toBeNull()
  })

  it('403 vira failed imediato', async () => {
    mock()
    pool().intercept({ path: commentPath, method: 'POST' }).reply(403, {})

    const post = await postPublicado()
    const c = await criarComentario(post.id)
    const r = await runComment(c, { dispatcher: agent })
    expect(r.outcome).toBe('failed')
    expect((await lerComentario(c.id)).status).toBe('failed')
  })

  it('429 agenda retentativa com backoff', async () => {
    mock()
    pool().intercept({ path: commentPath, method: 'POST' }).reply(429, {})

    const post = await postPublicado()
    const c = await criarComentario(post.id)
    const r = await runComment(c, { dispatcher: agent })
    expect(r.outcome).toBe('retry')

    const depois = await lerComentario(c.id)
    expect(depois.status).toBe('scheduled')
    expect(depois.retry_count).toBe(1)
    expect(depois.next_attempt_at).not.toBeNull()
    expect(depois.submit_attempted_at).toBeNull()
  })
})

describe('runComment — o post pai é pré-condição', () => {
  it('post sem reddit_fullname faz falhar SEM enviar', async () => {
    mock()
    // Nenhum intercept: qualquer chamada faria o MockAgent recusar.
    const post = await postPublicado({ reddit_fullname: null })
    const c = await criarComentario(post.id)
    const r = await runComment(c, { dispatcher: agent })

    expect(r.outcome).toBe('failed')
    const depois = await lerComentario(c.id)
    expect(depois.status).toBe('failed')
    // Nem chegou ao ponto sem volta.
    expect(depois.submit_attempted_at).toBeNull()
  })

  it('post em needs_review não tem comentário publicado', async () => {
    mock()
    const post = await criarJob(cenario, {
      status: 'needs_review',
      review_reason: 'OUTCOME_UNKNOWN',
      submit_attempted_at: new Date().toISOString(),
      locked_by: null,
      locked_at: null,
    })
    const c = await criarComentario(post.id)
    const r = await runComment(c, { dispatcher: agent })

    expect(r.outcome).toBe('failed')
    expect((await lerComentario(c.id)).reddit_comment_id).toBeNull()
  })

  it('a mensagem de falha explica o motivo em português claro', async () => {
    mock()
    const post = await postPublicado({ reddit_fullname: null })
    const c = await criarComentario(post.id)
    await runComment(c, { dispatcher: agent })

    const depois = await lerComentario(c.id)
    expect(depois.error_message).toMatch(/não tem onde ser feito/i)
  })
})
