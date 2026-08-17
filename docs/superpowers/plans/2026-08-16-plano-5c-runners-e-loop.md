# Plano 5 — Parte C: Runners e Loop do Worker

> Continuação de `2026-08-16-plano-5b-submissao-e-infra.md`.
> As Global Constraints do arquivo principal valem integralmente.

Tasks 6 a 9 fecham o **Bloco A**.

---

### Task 6: Runner de publicação

**Files:**
- Create: `src/lib/worker/log.ts`
- Create: `src/lib/worker/retry.ts`
- Create: `worker/post-runner.ts`
- Test: `tests/db/post-runner.test.ts`

**Interfaces:**
- Produces:
  - `logExecution(entry): Promise<void>` — grava em `execution_logs`, sanitizado
  - `nextAttemptAt(retryCount, retryAfterSeconds?): Date`
  - `MAX_RETRIES`
  - `runPost(job, opts): Promise<PostOutcome>`

**A sequência que importa.** Cada passo existe por um motivo específico:

1. carregar conta e comunidade;
2. `assertJobConsistency` — defesa em profundidade;
3. revalidar `post_requirements`, porque as regras podem ter mudado desde o
   agendamento;
4. **gravar e commitar `submit_attempted_at`** — o ponto sem volta;
5. enviar;
6. gravar resultado; se publicou, materializar o horário dos comentários.

Entre 4 e 6 está a janela de incerteza. O passo 4 custa um round-trip extra ao
banco, e é o que permite ao reaper distinguir "nunca saiu" de "pode ter
chegado".

**Retentativa por disposição** (regra da revisão 2 da spec):

| Disposição | Ação |
|---|---|
| `retryable` | `retry_count++`, backoff 1/5/25 min, respeitando `Retry-After`; após 3, `failed` |
| `terminal` | `failed` imediatamente — retentar seria inútil e abusivo |
| `unknown` | `needs_review`, **sem retry**, sem exceção |

- [ ] **Step 1: Escrever os testes de backoff e log**

```ts
// tests/worker/retry.test.ts
import { describe, expect, it } from 'vitest'
import { MAX_RETRIES, nextAttemptAt } from '@/lib/worker/retry'

describe('nextAttemptAt', () => {
  it('a primeira retentativa espera cerca de 1 minuto', () => {
    const d = nextAttemptAt(0)
    const espera = (d.getTime() - Date.now()) / 1000
    expect(espera).toBeGreaterThan(50)
    expect(espera).toBeLessThan(70)
  })

  it('o intervalo cresce a cada tentativa', () => {
    const a = nextAttemptAt(0).getTime()
    const b = nextAttemptAt(1).getTime()
    const c = nextAttemptAt(2).getTime()
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  it('respeita Retry-After quando é maior que o backoff', () => {
    const d = nextAttemptAt(0, 600)
    const espera = (d.getTime() - Date.now()) / 1000
    expect(espera).toBeGreaterThan(590)
  })

  it('ignora Retry-After menor que o backoff: não acelera a retentativa', () => {
    const d = nextAttemptAt(2, 5)
    const espera = (d.getTime() - Date.now()) / 1000
    expect(espera).toBeGreaterThan(60)
  })

  it('MAX_RETRIES é pequeno: retentar demais é abusivo', () => {
    expect(MAX_RETRIES).toBeLessThanOrEqual(3)
  })
})
```

```ts
// tests/db/execution-log-writer.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { logExecution } from '@/lib/worker/log'

let userA: { id: string; accessToken: string }

beforeAll(async () => {
  userA = await createTestUser(`lw-${Date.now()}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

async function ultimoLog() {
  const { data } = await adminClient()
    .from('execution_logs')
    .select('*')
    .eq('owner_id', userA.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  return data!
}

describe('logExecution', () => {
  it('grava a entrada', async () => {
    await logExecution({
      ownerId: userA.id,
      action: 'submit_post',
      outcome: 'success',
      httpStatus: 200,
      durationMs: 420,
    })

    const log = await ultimoLog()
    expect(log.action).toBe('submit_post')
    expect(log.outcome).toBe('success')
    expect(log.http_status).toBe(200)
  })

  it('SANITIZA a mensagem antes de gravar', async () => {
    await logExecution({
      ownerId: userA.id,
      action: 'submit_post',
      outcome: 'failure',
      errorMessage:
        'falhou com Authorization: bearer eyJabc123 via socks5://user:senha@proxy.exemplo.com:1080',
    })

    const log = await ultimoLog()
    expect(log.error_message).not.toContain('eyJabc123')
    expect(log.error_message).not.toContain('senha')
    expect(log.error_message).not.toContain('user:senha')
  })

  it('falha ao gravar log não derruba a operação', async () => {
    // Log é telemetria: um problema aqui não pode custar a publicação.
    await expect(
      logExecution({
        ownerId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        action: 'submit_post',
        outcome: 'success',
      }),
    ).resolves.toBeUndefined()
  })

  it('trunca mensagem muito longa', async () => {
    await logExecution({
      ownerId: userA.id,
      action: 'submit_post',
      outcome: 'failure',
      errorMessage: 'x'.repeat(5000),
    })

    const log = await ultimoLog()
    expect(log.error_message!.length).toBeLessThanOrEqual(2000)
  })
})
```

- [ ] **Step 2: Implementar log e backoff**

```ts
// src/lib/worker/retry.ts

/** Depois disso, o job é marcado como falho em vez de insistir. */
export const MAX_RETRIES = 3

const BACKOFF_SECONDS = [60, 300, 1500]

/**
 * Momento da próxima tentativa.
 *
 * `Retry-After` do Reddit só é considerado quando é MAIOR que o backoff:
 * ele pode encurtar a espera que nós mesmos impusemos, e insistir mais cedo
 * do que o combinado seria justamente o comportamento abusivo que a spec
 * proíbe.
 */
export function nextAttemptAt(
  retryCount: number,
  retryAfterSeconds?: number,
): Date {
  const indice = Math.min(retryCount, BACKOFF_SECONDS.length - 1)
  const base = BACKOFF_SECONDS[indice]
  const segundos = Math.max(base, retryAfterSeconds ?? 0)
  return new Date(Date.now() + segundos * 1000)
}
```

```ts
// src/lib/worker/log.ts
import { createServiceClient } from '@/lib/supabase/service-client'
import { sanitize } from '@/lib/logging/sanitize'

const MAX_MESSAGE = 2000

export type ExecutionLogEntry = {
  ownerId: string
  action: string
  outcome: 'success' | 'failure' | 'retry' | 'unknown'
  redditAccountId?: string | null
  scheduledPostId?: string | null
  scheduledCommentId?: string | null
  httpStatus?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  durationMs?: number | null
}

/**
 * Grava uma linha em execution_logs.
 *
 * A mensagem passa por `sanitize` antes de sair daqui — nenhum token, senha
 * de proxy, header Authorization ou URL com credenciais chega ao banco.
 *
 * Falhas são engolidas de propósito: log é telemetria e não pode custar a
 * operação do usuário.
 */
export async function logExecution(entry: ExecutionLogEntry): Promise<void> {
  try {
    const mensagem = entry.errorMessage
      ? String(sanitize(entry.errorMessage)).slice(0, MAX_MESSAGE)
      : null

    const service = createServiceClient()
    await service.from('execution_logs').insert({
      owner_id: entry.ownerId,
      reddit_account_id: entry.redditAccountId ?? null,
      scheduled_post_id: entry.scheduledPostId ?? null,
      scheduled_comment_id: entry.scheduledCommentId ?? null,
      action: entry.action,
      outcome: entry.outcome,
      http_status: entry.httpStatus ?? null,
      error_code: entry.errorCode ?? null,
      error_message: mensagem,
      duration_ms: entry.durationMs ?? null,
    })
  } catch {
    // Silenciado de propósito: ver JSDoc.
  }
}
```

- [ ] **Step 3: Escrever os testes do runner**

```ts
// tests/db/post-runner.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { encryptSecret } from '@/lib/crypto/aes-gcm'

let userA: { id: string; accessToken: string }
let conta: string
let sub: string
let agent: MockAgent

const pool = () => agent.get('https://oauth.reddit.com')
const reqPath = (p: string) => p.includes('/post_requirements')
const submitPath = (p: string) => p.startsWith('/api/submit')

const respostaOk = {
  json: {
    errors: [],
    data: {
      id: 'abc123',
      name: 't3_abc123',
      url: 'https://www.reddit.com/r/com_run/comments/abc123/t/',
    },
  },
}

async function criarJob(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_id: sub,
      title: 'Publicação do worker',
      url: 'https://exemplo.com/v',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      timezone: 'America/Sao_Paulo',
      status: 'processing',
      locked_at: new Date().toISOString(),
      locked_by: 'worker-teste',
      ...overrides,
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

async function rodar(job: Record<string, unknown>) {
  const { runPost } = await import('../../worker/post-runner')
  return runPost(job as never, { dispatcher: agent })
}

async function lerJob(id: string) {
  const { data } = await adminClient()
    .from('scheduled_posts')
    .select('*')
    .eq('id', id)
    .single()
  return data!
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  const stamp = Date.now()
  userA = await createTestUser(`pr-${stamp}@teste.local`)

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_pr_${stamp}`,
      username: 'conta_runner',
    })
    .select('id')
    .single()
  conta = c!.id as string

  await adminClient().from('reddit_account_secrets').insert({
    reddit_account_id: conta,
    owner_id: userA.id,
    access_token_enc: encryptSecret(
      'AT',
      `reddit_account_secrets:access_token:${conta}`,
    ),
    refresh_token_enc: encryptSecret(
      'RT',
      `reddit_account_secrets:refresh_token:${conta}`,
    ),
    access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })

  const { data: s } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_fullname: `t5_pr_${stamp}`,
      name: 'com_run',
      display_name: 'Comunidade',
      url: '/r/com_run/',
      submission_type: 'any',
    })
    .select('id')
    .single()
  sub = s!.id as string
})

beforeEach(async () => {
  process.env.REDDIT_CLIENT_ID = 'cid-suite-runner'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
  await adminClient().from('scheduled_posts').delete().eq('owner_id', userA.id)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('runPost — caminho feliz', () => {
  it('publica e grava identificadores', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(200, respostaOk)

    const job = await criarJob()
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).toBe('published')
    expect(depois.reddit_post_id).toBe('abc123')
    expect(depois.reddit_fullname).toBe('t3_abc123')
    expect(depois.reddit_permalink).toContain('reddit.com')
    expect(depois.published_at).not.toBeNull()
    expect(depois.locked_by).toBeNull()
  })

  it('grava submit_attempted_at ANTES de enviar', async () => {
    // Sem isso, o reaper não consegue distinguir "não saiu" de "pode ter
    // chegado".
    let attemptedNoMomentoDoEnvio: string | null = null

    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, async () => {
        const { data } = await adminClient()
          .from('scheduled_posts')
          .select('submit_attempted_at')
          .eq('id', jobId)
          .single()
        attemptedNoMomentoDoEnvio = data!.submit_attempted_at
        return respostaOk
      })

    const job = await criarJob()
    const jobId = job.id
    await rodar(job)

    expect(attemptedNoMomentoDoEnvio).not.toBeNull()
  })

  it('atualiza last_submit_at da conta, para o espaçamento valer', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(200, respostaOk)

    await adminClient()
      .from('reddit_accounts')
      .update({ last_submit_at: null })
      .eq('id', conta)

    const job = await criarJob()
    await rodar(job)

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('last_submit_at')
      .eq('id', conta)
      .single()
    expect(data!.last_submit_at).not.toBeNull()
  })

  it('materializa o horário dos comentários pendentes', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(200, respostaOk)

    const job = await criarJob()
    await adminClient().from('scheduled_comments').insert([
      {
        owner_id: userA.id,
        scheduled_post_id: job.id,
        reddit_account_id: conta,
        body: 'imediato',
        mode: 'immediate',
        delay_minutes: null,
        scheduled_at: null,
        status: 'scheduled',
      },
    ])

    await rodar(job)

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('scheduled_at')
      .eq('scheduled_post_id', job.id)
      .single()
    expect(data!.scheduled_at).not.toBeNull()
  })

  it('registra log de sucesso', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(200, respostaOk)

    const job = await criarJob()
    await rodar(job)

    const { data } = await adminClient()
      .from('execution_logs')
      .select('action, outcome')
      .eq('scheduled_post_id', job.id)
    expect(data!.some((l) => l.outcome === 'success')).toBe(true)
  })
})

describe('runPost — erro retentável', () => {
  it('agenda nova tentativa com backoff', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(429, {}, { headers: { 'retry-after': '30' } })

    const job = await criarJob()
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).toBe('scheduled')
    expect(depois.retry_count).toBe(1)
    expect(new Date(depois.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
    expect(depois.locked_by).toBeNull()
  })

  it('desiste depois do limite de tentativas', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(429, {})

    const { MAX_RETRIES } = await import('@/lib/worker/retry')
    const job = await criarJob({ retry_count: MAX_RETRIES })
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).toBe('failed')
    expect(depois.error_code).toBeTruthy()
  })
})

describe('runPost — erro terminal', () => {
  it('falha de imediato, sem retentar', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(403, {})

    const job = await criarJob()
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).toBe('failed')
    expect(depois.retry_count).toBe(0)
    expect(depois.error_code).toBe('NO_PERMISSION')
  })

  it('guarda mensagem humana para o dashboard', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(403, {})

    const job = await criarJob()
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.error_message).toMatch(/permiss/i)
  })
})

describe('runPost — resultado desconhecido', () => {
  it('5xx manda para needs_review, sem retentar', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(503, {})

    const job = await criarJob()
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).toBe('needs_review')
    expect(depois.retry_count).toBe(0)
    expect(depois.next_attempt_at).toBeNull()
    expect(depois.review_reason).toBeTruthy()
  })

  it('queda de conexão após o envio manda para needs_review', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

    const job = await criarJob()
    await rodar(job)

    expect((await lerJob(job.id)).status).toBe('needs_review')
  })

  it('registra log com outcome unknown', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    pool().intercept({ path: submitPath, method: 'POST' }).reply(503, {})

    const job = await criarJob()
    await rodar(job)

    const { data } = await adminClient()
      .from('execution_logs')
      .select('outcome')
      .eq('scheduled_post_id', job.id)
    expect(data!.some((l) => l.outcome === 'unknown')).toBe(true)
  })
})

describe('runPost — validação antes de enviar', () => {
  it('falha ao ler requisitos NÃO publica', async () => {
    // Herdado do Plano 3: indisponibilidade não vira permissão.
    pool().intercept({ path: reqPath, method: 'GET' }).reply(403, {})
    // Nenhum intercept de submit: se publicasse, o teste falharia.

    const job = await criarJob()
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).not.toBe('published')
    expect(depois.reddit_post_id).toBeNull()
  })

  it('requisito violado desde o agendamento vira falha, não publicação', async () => {
    // A comunidade passou a exigir flair depois que o post foi agendado.
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { is_flair_required: true })

    const job = await criarJob({ flair_id: null })
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).toBe('failed')
    expect(depois.error_message).toMatch(/flair/i)
  })

  it('conta desconectada no meio do caminho não publica', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', conta)

    const job = await criarJob()
    await rodar(job)

    const depois = await lerJob(job.id)
    expect(depois.status).not.toBe('published')

    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'connected' })
      .eq('id', conta)
  })
})
```

- [ ] **Step 4: Implementar o runner**

```ts
// worker/post-runner.ts
import type { Dispatcher } from 'undici'
import { createServiceClient } from '@/lib/supabase/service-client'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { getPostRequirements } from '@/lib/reddit/requirements'
import { buildPayload, PayloadError } from '@/lib/scheduling/payload-builder'
import { submitPost } from '@/lib/reddit/posts'
import { RedditError } from '@/lib/reddit/errors'
import { loadAccountForWorker } from '@/lib/worker/load-account'
import { assertJobConsistency } from '@/lib/worker/consistency'
import { logExecution } from '@/lib/worker/log'
import { MAX_RETRIES, nextAttemptAt } from '@/lib/worker/retry'

export type PostJob = {
  id: string
  owner_id: string
  reddit_account_id: string
  subreddit_id: string
  title: string
  url: string | null
  body: string | null
  post_kind: 'link' | 'self'
  flair_id: string | null
  nsfw: boolean
  spoiler: boolean
  retry_count: number
}

export type PostOutcome =
  | 'published'
  | 'retry'
  | 'failed'
  | 'needs_review'

export async function runPost(
  job: PostJob,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<PostOutcome> {
  const service = createServiceClient()
  const inicio = Date.now()

  const log = (
    outcome: 'success' | 'failure' | 'retry' | 'unknown',
    extra: { errorCode?: string; errorMessage?: string; httpStatus?: number } = {},
  ) =>
    logExecution({
      ownerId: job.owner_id,
      redditAccountId: job.reddit_account_id,
      scheduledPostId: job.id,
      action: 'submit_post',
      outcome,
      durationMs: Date.now() - inicio,
      ...extra,
    })

  /** Libera o lock e registra o desfecho terminal. */
  const finalizar = async (patch: Record<string, unknown>) => {
    await service
      .from('scheduled_posts')
      .update({ locked_at: null, locked_by: null, ...patch })
      .eq('id', job.id)
  }

  try {
    // --- 1 e 2: conta, comunidade e coerência ---
    const account = await loadAccountForWorker(job.reddit_account_id)

    const { data: subreddit } = await service
      .from('subreddits')
      .select('id, name, owner_id, reddit_account_id, submission_type, link_flair_enabled')
      .eq('id', job.subreddit_id)
      .single()

    if (!subreddit) throw new Error('Comunidade não encontrada.')

    assertJobConsistency({
      postOwnerId: job.owner_id,
      accountOwnerId: account.owner_id,
      subredditOwnerId: subreddit.owner_id as string,
      postAccountId: job.reddit_account_id,
      subredditAccountId: subreddit.reddit_account_id as string,
    })

    const client = await getRedditClient(account, {
      dispatcher: opts.dispatcher,
      skipOwnershipCheck: true,
    })

    // --- 3: requisitos podem ter mudado desde o agendamento ---
    const requirements = await getPostRequirements(client, subreddit.name as string)

    const payload = buildPayload(
      {
        title: job.title,
        url: job.url ?? undefined,
        body: job.body ?? undefined,
        flairId: job.flair_id ?? undefined,
        nsfw: job.nsfw,
        spoiler: job.spoiler,
        // O redirecionamento para comentário já aconteceu no agendamento.
        allowCommentFallback: true,
      },
      requirements,
      {
        name: subreddit.name as string,
        submissionType:
          (subreddit.submission_type as 'any' | 'link' | 'self') ?? 'any',
        linkFlairEnabled: Boolean(subreddit.link_flair_enabled),
      },
    )

    // --- 4: o ponto sem volta ---
    // Gravado e commitado ANTES do envio: é o que permite ao reaper saber
    // que a requisição pode ter chegado ao Reddit.
    await service
      .from('scheduled_posts')
      .update({ submit_attempted_at: new Date().toISOString() })
      .eq('id', job.id)

    // --- 5: enviar ---
    const resultado = await submitPost(client, {
      subredditName: subreddit.name as string,
      postKind: payload.postKind,
      title: payload.title,
      url: payload.url,
      body: payload.body,
      flairId: payload.flairId,
      nsfw: payload.nsfw,
      spoiler: payload.spoiler,
    })

    // --- 6: gravar resultado ---
    const publishedAt = new Date().toISOString()
    await finalizar({
      status: 'published',
      reddit_post_id: resultado.redditPostId,
      reddit_fullname: resultado.redditFullname,
      reddit_permalink: resultado.permalink,
      published_at: publishedAt,
      error_code: null,
      error_message: null,
      next_attempt_at: null,
    })

    // Espaçamento entre publicações da mesma conta.
    await service
      .from('reddit_accounts')
      .update({ last_submit_at: publishedAt })
      .eq('id', account.id)

    // Comentários em modo immediate/delay só agora ganham horário.
    await service.rpc('materialize_comment_schedule', {
      p_post_id: job.id,
      p_published_at: publishedAt,
    })

    await log('success', { httpStatus: 200 })
    return 'published'
  } catch (e) {
    // --- resultado desconhecido: nunca retentar ---
    if (e instanceof RedditError && e.disposition === 'unknown') {
      await finalizar({
        status: 'needs_review',
        review_reason: e.code,
        error_code: e.code,
        error_message: e.userMessage,
        next_attempt_at: null,
      })
      await log('unknown', { errorCode: e.code, errorMessage: e.userMessage })
      return 'needs_review'
    }

    // --- retentável ---
    if (e instanceof RedditError && e.disposition === 'retryable') {
      const tentativas = job.retry_count + 1
      if (tentativas > MAX_RETRIES) {
        await finalizar({
          status: 'failed',
          retry_count: tentativas,
          error_code: e.code,
          error_message: e.userMessage,
          // Limpo: o job não vai mais ser tentado.
          submit_attempted_at: null,
        })
        await log('failure', { errorCode: e.code, errorMessage: e.userMessage })
        return 'failed'
      }

      await finalizar({
        status: 'scheduled',
        retry_count: tentativas,
        next_attempt_at: nextAttemptAt(
          job.retry_count,
          e.retryAfterSeconds,
        ).toISOString(),
        error_code: e.code,
        error_message: e.userMessage,
        // A tentativa não chegou a produzir efeito conhecido; o campo é
        // limpo para o job voltar à fila de forma segura.
        submit_attempted_at: null,
      })
      await log('retry', { errorCode: e.code, errorMessage: e.userMessage })
      return 'retry'
    }

    // --- terminal, inclusive erros locais ---
    const codigo =
      e instanceof RedditError
        ? e.code
        : e instanceof PayloadError
          ? 'PAYLOAD_INVALID'
          : 'INTERNAL_ERROR'
    const mensagem =
      e instanceof RedditError
        ? e.userMessage
        : e instanceof PayloadError
          ? e.userMessage
          : 'Não foi possível publicar por um erro interno.'

    await finalizar({
      status: 'failed',
      error_code: codigo,
      error_message: mensagem,
      submit_attempted_at: null,
    })
    await log('failure', { errorCode: codigo, errorMessage: mensagem })
    return 'failed'
  }
}
```

**Atenção ao limpar `submit_attempted_at` no caminho retentável.** Isso só é
correto porque um erro `retryable` significa, por definição da tabela de
disposições do Plano 2, que o Reddit comprovadamente **não** processou o
pedido — 429 é recusa explícita, e falhas de rede pré-envio não chegaram a
sair. Se essa classificação mudar, esta linha precisa mudar junto.

- [ ] **Step 5: Rodar, verificar e commitar**

```powershell
npx vitest run tests/worker tests/db/post-runner.test.ts tests/db/execution-log-writer.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: runner de publicacao com disposicoes e janela de incerteza"
```

---

### Task 7: Runner de comentário

**Files:**
- Create: `worker/comment-runner.ts`
- Test: `tests/db/comment-runner.test.ts`

**Interfaces:**
- Produces: `runComment(job, opts): Promise<CommentOutcome>`

Mesmo desenho do runner de publicação, com uma diferença: o comentário depende
do `reddit_fullname` do post pai. Se o post não publicou, o comentário não tem
onde ser feito — e o `claim_due_comments` já garante isso, mas o runner
reconfere antes de enviar.

- [ ] **Step 1: Escrever os testes**

```ts
// tests/db/comment-runner.test.ts
// Mesmo arranjo do post-runner: conta, segredos, comunidade e um post já
// publicado com reddit_fullname preenchido.
//
// Casos obrigatórios:
//   - publica o comentário e grava id, fullname e permalink
//   - grava submit_attempted_at antes de enviar
//   - 5xx vira needs_review, sem retry
//   - 403 vira failed imediato
//   - 429 agenda retentativa com backoff
//   - post pai sem reddit_fullname faz o comentário falhar sem enviar
//   - post pai que virou needs_review não tem comentário publicado
//   - registra log com o scheduled_comment_id preenchido
```

O arquivo completo segue exatamente a estrutura de `post-runner.test.ts`,
trocando `scheduled_posts` por `scheduled_comments`, `submitPath` por
`commentPath` e a resposta de sucesso pelo envelope `json.data.things[0]`.

- [ ] **Step 2: Implementar**

```ts
// worker/comment-runner.ts
import type { Dispatcher } from 'undici'
import { createServiceClient } from '@/lib/supabase/service-client'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { submitComment } from '@/lib/reddit/comments'
import { RedditError } from '@/lib/reddit/errors'
import { loadAccountForWorker } from '@/lib/worker/load-account'
import { logExecution } from '@/lib/worker/log'
import { MAX_RETRIES, nextAttemptAt } from '@/lib/worker/retry'

export type CommentJob = {
  id: string
  owner_id: string
  scheduled_post_id: string
  reddit_account_id: string
  body: string
  retry_count: number
}

export type CommentOutcome = 'published' | 'retry' | 'failed' | 'needs_review'

export async function runComment(
  job: CommentJob,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<CommentOutcome> {
  const service = createServiceClient()
  const inicio = Date.now()

  const log = (
    outcome: 'success' | 'failure' | 'retry' | 'unknown',
    extra: { errorCode?: string; errorMessage?: string } = {},
  ) =>
    logExecution({
      ownerId: job.owner_id,
      redditAccountId: job.reddit_account_id,
      scheduledPostId: job.scheduled_post_id,
      scheduledCommentId: job.id,
      action: 'submit_comment',
      outcome,
      durationMs: Date.now() - inicio,
      ...extra,
    })

  const finalizar = async (patch: Record<string, unknown>) => {
    await service
      .from('scheduled_comments')
      .update({ locked_at: null, locked_by: null, ...patch })
      .eq('id', job.id)
  }

  try {
    // O comentário só existe se o post existir no Reddit. O claim já filtra,
    // mas reconferimos: entre o claim e agora, o post pode ter mudado.
    const { data: post } = await service
      .from('scheduled_posts')
      .select('status, reddit_fullname, owner_id, reddit_account_id')
      .eq('id', job.scheduled_post_id)
      .single()

    if (
      !post ||
      post.status !== 'published' ||
      typeof post.reddit_fullname !== 'string'
    ) {
      await finalizar({
        status: 'failed',
        error_code: 'PARENT_NOT_PUBLISHED',
        error_message:
          'A publicação não foi concluída, então o comentário não pôde ser enviado.',
      })
      await log('failure', { errorCode: 'PARENT_NOT_PUBLISHED' })
      return 'failed'
    }

    // Coerência entre comentário e post pai.
    if (
      post.owner_id !== job.owner_id ||
      post.reddit_account_id !== job.reddit_account_id
    ) {
      await finalizar({
        status: 'failed',
        error_code: 'INCONSISTENT_OWNERSHIP',
        error_message: 'Vínculos inconsistentes entre comentário e publicação.',
      })
      await log('failure', { errorCode: 'INCONSISTENT_OWNERSHIP' })
      return 'failed'
    }

    const account = await loadAccountForWorker(job.reddit_account_id)
    const client = await getRedditClient(account, {
      dispatcher: opts.dispatcher,
      skipOwnershipCheck: true,
    })

    // Ponto sem volta, como no runner de publicação.
    await service
      .from('scheduled_comments')
      .update({ submit_attempted_at: new Date().toISOString() })
      .eq('id', job.id)

    const resultado = await submitComment(client, {
      thingId: post.reddit_fullname,
      body: job.body,
    })

    await finalizar({
      status: 'published',
      reddit_comment_id: resultado.redditCommentId,
      reddit_permalink: resultado.permalink,
      published_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
      next_attempt_at: null,
    })
    await log('success')
    return 'published'
  } catch (e) {
    if (e instanceof RedditError && e.disposition === 'unknown') {
      await finalizar({
        status: 'needs_review',
        review_reason: e.code,
        error_code: e.code,
        error_message: e.userMessage,
        next_attempt_at: null,
      })
      await log('unknown', { errorCode: e.code, errorMessage: e.userMessage })
      return 'needs_review'
    }

    if (e instanceof RedditError && e.disposition === 'retryable') {
      const tentativas = job.retry_count + 1
      if (tentativas > MAX_RETRIES) {
        await finalizar({
          status: 'failed',
          retry_count: tentativas,
          error_code: e.code,
          error_message: e.userMessage,
          submit_attempted_at: null,
        })
        await log('failure', { errorCode: e.code, errorMessage: e.userMessage })
        return 'failed'
      }

      await finalizar({
        status: 'scheduled',
        retry_count: tentativas,
        next_attempt_at: nextAttemptAt(
          job.retry_count,
          e.retryAfterSeconds,
        ).toISOString(),
        error_code: e.code,
        error_message: e.userMessage,
        submit_attempted_at: null,
      })
      await log('retry', { errorCode: e.code, errorMessage: e.userMessage })
      return 'retry'
    }

    const codigo = e instanceof RedditError ? e.code : 'INTERNAL_ERROR'
    const mensagem =
      e instanceof RedditError
        ? e.userMessage
        : 'Não foi possível comentar por um erro interno.'

    await finalizar({
      status: 'failed',
      error_code: codigo,
      error_message: mensagem,
      submit_attempted_at: null,
    })
    await log('failure', { errorCode: codigo, errorMessage: mensagem })
    return 'failed'
  }
}
```

- [ ] **Step 3: Rodar, verificar e commitar**

```powershell
npx vitest run tests/db/comment-runner.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: runner de comentario programado"
```

---

### Task 8: Loop do worker

**Files:**
- Create: `worker/index.ts`
- Create: `src/lib/worker/config.ts`
- Test: `tests/worker/config.test.ts`
- Test: `tests/db/worker-cycle.test.ts`

**Interfaces:**
- Produces:
  - `getWorkerConfig()` — intervalo, batch, timeout do reaper, id da instância
  - `runCycle(opts): Promise<CycleReport>` — um ciclo completo, testável
  - `main()` — laço com desligamento gracioso

**Um ciclo faz, nesta ordem:**

1. reaper — devolve à fila o que o worker anterior deixou preso;
2. orçamento — se pausado, espera até o reset (o worker **pode** dormir, ao
   contrário da Vercel);
3. claim de publicações → processa **sequencialmente**;
4. claim de comentários → processa sequencialmente;
5. limpeza de logs vencidos, uma vez por hora.

**Sequencial de propósito.** Paralelizar publicações da mesma conta furaria o
espaçamento, e paralelizar contas diferentes multiplicaria o consumo de
orçamento sem ganho real — o gargalo é o rate limit do Reddit, não a CPU.

- [ ] **Step 1: Escrever os testes de configuração e ciclo**

```ts
// tests/worker/config.test.ts
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x'
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_x'
  process.env.APP_URL = 'http://localhost:3000'
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64')
  delete process.env.WORKER_INTERVAL_SECONDS
  delete process.env.WORKER_ID
  delete process.env.WORKER_BATCH_SIZE
})

describe('getWorkerConfig', () => {
  it('usa padrões sensatos quando nada é configurado', async () => {
    const { getWorkerConfig } = await import('@/lib/worker/config')
    const c = getWorkerConfig()
    expect(c.intervalSeconds).toBeGreaterThan(0)
    expect(c.batchSize).toBeGreaterThan(0)
    expect(c.reaperTimeoutSeconds).toBeGreaterThanOrEqual(300)
  })

  it('gera um id de instância quando não informado', async () => {
    const { getWorkerConfig } = await import('@/lib/worker/config')
    expect(getWorkerConfig().workerId.length).toBeGreaterThan(3)
  })

  it('respeita as variáveis de ambiente', async () => {
    process.env.WORKER_INTERVAL_SECONDS = '15'
    process.env.WORKER_BATCH_SIZE = '5'
    process.env.WORKER_ID = 'vps-1'

    const { getWorkerConfig } = await import('@/lib/worker/config')
    const c = getWorkerConfig()
    expect(c.intervalSeconds).toBe(15)
    expect(c.batchSize).toBe(5)
    expect(c.workerId).toBe('vps-1')
  })

  it('recusa intervalo absurdo em vez de aceitar em silêncio', async () => {
    process.env.WORKER_INTERVAL_SECONDS = '0'
    const { getWorkerConfig } = await import('@/lib/worker/config')
    expect(() => getWorkerConfig()).toThrow()
  })

  it('o timeout do reaper é maior que o intervalo, para não matar job vivo', async () => {
    const { getWorkerConfig } = await import('@/lib/worker/config')
    const c = getWorkerConfig()
    expect(c.reaperTimeoutSeconds).toBeGreaterThan(c.intervalSeconds)
  })
})
```

```ts
// tests/db/worker-cycle.test.ts
// Arranjo igual ao do post-runner. Casos obrigatórios:
//   - ciclo sem jobs devolve relatório zerado e não chama a API
//   - ciclo com um job vencido publica e relata 1 publicação
//   - ciclo roda o reaper antes do claim (job preso volta e é processado)
//   - orçamento pausado impede o ciclo de chamar a API
//   - jobs da mesma conta são processados um por vez, respeitando espaçamento
//   - erro em um job não impede o processamento do próximo
//   - o relatório traz contagens por desfecho
```

- [ ] **Step 2: Implementar a configuração**

```ts
// src/lib/worker/config.ts
import { randomBytes } from 'node:crypto'

export type WorkerConfig = {
  workerId: string
  intervalSeconds: number
  batchSize: number
  reaperTimeoutSeconds: number
  logRetentionDays: number
}

function inteiro(nome: string, valor: string | undefined, padrao: number) {
  if (valor === undefined || valor === '') return padrao
  const n = Number(valor)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${nome} precisa ser um inteiro positivo. Recebido: ${valor}`)
  }
  return n
}

export function getWorkerConfig(): WorkerConfig {
  const intervalSeconds = inteiro(
    'WORKER_INTERVAL_SECONDS',
    process.env.WORKER_INTERVAL_SECONDS,
    30,
  )
  const reaperTimeoutSeconds = inteiro(
    'WORKER_REAPER_TIMEOUT_SECONDS',
    process.env.WORKER_REAPER_TIMEOUT_SECONDS,
    600,
  )

  if (reaperTimeoutSeconds <= intervalSeconds) {
    // Um timeout menor que o intervalo mataria jobs que ainda estão rodando.
    throw new Error(
      'WORKER_REAPER_TIMEOUT_SECONDS precisa ser maior que WORKER_INTERVAL_SECONDS.',
    )
  }

  return {
    workerId:
      process.env.WORKER_ID || `worker-${randomBytes(4).toString('hex')}`,
    intervalSeconds,
    batchSize: inteiro('WORKER_BATCH_SIZE', process.env.WORKER_BATCH_SIZE, 10),
    reaperTimeoutSeconds,
    logRetentionDays: inteiro(
      'WORKER_LOG_RETENTION_DAYS',
      process.env.WORKER_LOG_RETENTION_DAYS,
      30,
    ),
  }
}
```

- [ ] **Step 3: Implementar o loop**

```ts
// worker/index.ts
import { existsSync } from 'node:fs'
import type { Dispatcher } from 'undici'
import { createServiceClient } from '@/lib/supabase/service-client'
import { getWorkerConfig } from '@/lib/worker/config'
import { getBudget } from '@/lib/reddit/budget'
import { sanitize } from '@/lib/logging/sanitize'
import { runPost, type PostJob } from './post-runner'
import { runComment, type CommentJob } from './comment-runner'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')

export type CycleReport = {
  reaped: number
  posts: Record<string, number>
  comments: Record<string, number>
  pausedForBudget: boolean
}

const dormir = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

let parando = false

/**
 * Um ciclo completo. Exportado para ser testável sem subir o laço.
 */
export async function runCycle(
  opts: { dispatcher?: Dispatcher } = {},
): Promise<CycleReport> {
  const config = getWorkerConfig()
  const service = createServiceClient()

  const relatorio: CycleReport = {
    reaped: 0,
    posts: {},
    comments: {},
    pausedForBudget: false,
  }

  // --- 1: reaper antes de tudo ---
  const { data: reaped } = await service.rpc('reap_stale_jobs', {
    p_timeout_seconds: config.reaperTimeoutSeconds,
  })
  relatorio.reaped = (reaped ?? []).length

  // --- 2: orçamento ---
  // Diferente da Vercel, aqui podemos esperar: o worker não está segurando
  // uma requisição HTTP de ninguém.
  const budget = await getBudget()
  if (budget?.pausedUntil && budget.pausedUntil.getTime() > Date.now()) {
    relatorio.pausedForBudget = true
    return relatorio
  }

  // --- 3: publicações, uma por vez ---
  const { data: posts } = await service.rpc('claim_due_posts', {
    p_worker_id: config.workerId,
    p_batch: config.batchSize,
  })

  for (const job of (posts ?? []) as PostJob[]) {
    if (parando) break
    try {
      const desfecho = await runPost(job, opts)
      relatorio.posts[desfecho] = (relatorio.posts[desfecho] ?? 0) + 1
    } catch (e) {
      // Um job problemático não pode derrubar o ciclo inteiro.
      console.error('worker: falha inesperada em publicação', sanitize(e))
      relatorio.posts.error = (relatorio.posts.error ?? 0) + 1
    }
  }

  // --- 4: comentários ---
  const { data: comments } = await service.rpc('claim_due_comments', {
    p_worker_id: config.workerId,
    p_batch: config.batchSize,
  })

  for (const job of (comments ?? []) as CommentJob[]) {
    if (parando) break
    try {
      const desfecho = await runComment(job, opts)
      relatorio.comments[desfecho] = (relatorio.comments[desfecho] ?? 0) + 1
    } catch (e) {
      console.error('worker: falha inesperada em comentário', sanitize(e))
      relatorio.comments.error = (relatorio.comments.error ?? 0) + 1
    }
  }

  return relatorio
}

async function limparLogsAntigos() {
  const { logRetentionDays } = getWorkerConfig()
  const corte = new Date(Date.now() - logRetentionDays * 86_400_000)
  const service = createServiceClient()
  await service.from('execution_logs').delete().lt('created_at', corte.toISOString())
}

async function main() {
  const config = getWorkerConfig()
  console.log(
    `worker ${config.workerId} iniciado: ciclo a cada ${config.intervalSeconds}s, ` +
      `lote de ${config.batchSize}, reaper em ${config.reaperTimeoutSeconds}s`,
  )
  console.log(
    `undici bundled: ${process.versions.undici} | instalado: ver package.json`,
  )

  // Desligamento gracioso: para de pegar jobs novos e deixa o atual terminar.
  for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sinal, () => {
      if (parando) process.exit(1)
      console.log(`worker: ${sinal} recebido, encerrando após o job atual…`)
      parando = true
    })
  }

  let ultimaLimpeza = 0

  while (!parando) {
    const inicio = Date.now()
    try {
      const r = await runCycle()
      if (r.reaped > 0 || Object.keys(r.posts).length > 0 || Object.keys(r.comments).length > 0) {
        console.log('worker: ciclo', JSON.stringify(r))
      }
      if (r.pausedForBudget) {
        console.log('worker: orçamento do Reddit esgotado, aguardando reset')
      }
    } catch (e) {
      console.error('worker: ciclo falhou', sanitize(e))
    }

    if (Date.now() - ultimaLimpeza > 3_600_000) {
      try {
        await limparLogsAntigos()
        ultimaLimpeza = Date.now()
      } catch (e) {
        console.error('worker: limpeza de logs falhou', sanitize(e))
      }
    }

    const gasto = Date.now() - inicio
    const espera = Math.max(0, config.intervalSeconds * 1000 - gasto)
    if (!parando) await dormir(espera)
  }

  console.log('worker: encerrado')
}

// Só executa o laço quando chamado diretamente, nunca ao ser importado por
// um teste.
if (process.argv[1]?.includes('worker')) {
  main().catch((e) => {
    console.error('worker: erro fatal', sanitize(e))
    process.exit(1)
  })
}
```

- [ ] **Step 4: Adicionar o script npm**

```json
{
  "scripts": {
    "worker": "tsx worker/index.ts",
    "worker:once": "tsx --eval \"import('./worker/index.ts').then(m => m.runCycle()).then(r => console.log(JSON.stringify(r, null, 2)))\""
  }
}
```

```powershell
npm install -D tsx
```

- [ ] **Step 5: Rodar, verificar e commitar**

```powershell
npx vitest run tests/worker tests/db/worker-cycle.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: loop do worker com reaper, orcamento e desligamento gracioso"
```

---

### Task 9: Empacotamento e operação

**Files:**
- Create: `Dockerfile.worker`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Escrever o Dockerfile**

```dockerfile
# Dockerfile.worker
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# ci garante exatamente o lockfile; o worker não usa nada de dev em runtime,
# mas precisa de tsx para executar TypeScript sem passo de build.
RUN npm ci

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/lib ./src/lib
COPY worker ./worker

# Não roda como root.
USER node

CMD ["npx", "tsx", "worker/index.ts"]
```

```
# .dockerignore
node_modules
.next
.git
docs
tests
supabase
.env
.env.local
```

- [ ] **Step 2: Escrever o compose**

```yaml
# docker-compose.yml
services:
  worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    restart: unless-stopped
    env_file:
      - .env.worker
    environment:
      # Identificação da instância nos logs e no campo locked_by.
      WORKER_ID: ${WORKER_ID:-vps-1}
    # O worker não expõe porta: ele só consome fila e fala com o Reddit.
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(0)"]
      interval: 60s
      timeout: 5s
      retries: 3
```

- [ ] **Step 3: Documentar a operação no README**

````markdown
## Worker de publicação

O worker é um processo separado do painel: ele consome a fila e publica no
Reddit. Sem ele rodando, os agendamentos ficam parados no banco — que é o
estado esperado, não um defeito.

### Rodar localmente

```bash
npm run worker          # laço contínuo
npm run worker:once     # um único ciclo, útil para depurar
```

### Rodar no VPS

```bash
cp .env.example .env.worker   # preencha com as credenciais de produção
docker compose up -d worker
docker compose logs -f worker
```

### Variáveis

| Variável | Padrão | O que faz |
|---|---|---|
| `WORKER_ID` | gerado | identifica a instância em `locked_by` |
| `WORKER_INTERVAL_SECONDS` | 30 | intervalo entre ciclos |
| `WORKER_BATCH_SIZE` | 10 | jobs por ciclo |
| `WORKER_REAPER_TIMEOUT_SECONDS` | 600 | quando considerar um job preso |
| `WORKER_LOG_RETENTION_DAYS` | 30 | retenção de `execution_logs` |

`WORKER_REAPER_TIMEOUT_SECONDS` precisa ser maior que
`WORKER_INTERVAL_SECONDS`, senão o reaper mataria jobs ainda em execução. O
worker recusa iniciar com essa configuração.

### Várias instâncias

É seguro rodar mais de uma: o claim usa `FOR UPDATE SKIP LOCKED`, então duas
instâncias nunca processam o mesmo job ao mesmo tempo. O orçamento de rate
limit é compartilhado por `client_id`, então elas não estouram o limite juntas.

### Desligamento

`SIGTERM` faz o worker parar de pegar jobs novos e terminar o atual. Um
segundo sinal força a saída. Jobs interrompidos no meio são tratados pelo
reaper no próximo ciclo — e, se já havia tentativa de envio, vão para revisão
manual em vez de serem republicados.
````

- [ ] **Step 4: Acrescentar as variáveis ao `.env.example`**

```bash
# ---- Worker (Plano 5) ----
WORKER_ID=worker-local
WORKER_INTERVAL_SECONDS=30
WORKER_BATCH_SIZE=10
WORKER_REAPER_TIMEOUT_SECONDS=600
WORKER_LOG_RETENTION_DAYS=30
```

- [ ] **Step 5: Verificar a imagem**

```powershell
docker build -f Dockerfile.worker -t reddit-scheduler-worker .
docker run --rm --env-file .env.local reddit-scheduler-worker npx tsx --version
```

Expected: a imagem constrói e o `tsx` responde. Não rode o laço completo
apontando para o Supabase local a partir do container sem ajustar o host —
`127.0.0.1` dentro do container não é a sua máquina.

- [ ] **Step 6: Verificar e commitar**

```powershell
npm run verify
```

```bash
git add -A
git commit -m "chore: empacotamento e documentacao operacional do worker"
```

---

## Checkpoint do Bloco A

Antes de começar o Bloco B, o worker precisa estar provado:

- [ ] `npm run verify` verde e estável
- [ ] claim concorrente não entrega o mesmo job duas vezes
- [ ] `submit_attempted_at` é gravado antes do envio, verificado de dentro do mock
- [ ] resultado desconhecido vira `needs_review` sem retentar
- [ ] reaper devolve à fila apenas o que não enviou
- [ ] retentativa respeita backoff e não acelera com `Retry-After` menor
- [ ] falha ao ler requisitos não publica
- [ ] logs não contêm token, senha de proxy nem header de autorização
- [ ] `npx supabase db advisors --local` sem apontamentos

As páginas do Bloco B seguem em `2026-08-16-plano-5d-paginas.md`.
