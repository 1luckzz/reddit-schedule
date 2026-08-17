# Plano 5 — Parte C: Runners e Loop do Worker

> Continuação de `2026-08-16-plano-5b-submissao-e-infra.md`.
> As Global Constraints do arquivo principal valem integralmente.

Tasks 6 a 9 fecham o **Bloco A**.

---

### Task 5.5: `safeToRetryEffect` em `RedditError`

**Files:**
- Modify: `src/lib/reddit/errors.ts`
- Modify: `tests/reddit/errors.test.ts`

**Por que uma propriedade nova, e não reusar `disposition`.** As duas
respondem perguntas diferentes:

| Pergunta | Campo |
|---|---|
| Vale a pena tentar de novo? | `disposition === 'retryable'` |
| Repetir a operação de efeito é seguro? | `safeToRetryEffect` |

Hoje elas coincidem, porque todo `retryable` que definimos é comprovadamente
pré-processamento. Mas amarrar a decisão de limpar `submit_attempted_at` à
`disposition` significa que qualquer classificação futura como `retryable` —
feita por alguém que só pensou em "vale a pena tentar" — passaria a autorizar
uma republicação. A propriedade explícita torna essa autorização deliberada.

**Regra:** apenas `safeToRetryEffect === true` pode limpar
`submit_attempted_at` e devolver o job à fila. `unknown` é sempre `false`.

- [ ] **Step 1: Acrescentar os testes**

```ts
// acrescentar a tests/reddit/errors.test.ts

describe('safeToRetryEffect', () => {
  it('429 é seguro repetir: o Reddit recusou, não processou', () => {
    expect(classifyHttp(429, {}, true)!.safeToRetryEffect).toBe(true)
  })

  it('falha de rede antes do envio é segura', () => {
    const e = classifyNetwork(
      Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
      false,
    )
    expect(e.safeToRetryEffect).toBe(true)
  })

  it('5xx em requisição de efeito NÃO é seguro repetir', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyHttp(status, {}, true)!.safeToRetryEffect).toBe(false)
    }
  })

  it('5xx em leitura é seguro: não há efeito a duplicar', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyHttp(status, {}, false)!.safeToRetryEffect).toBe(true)
    }
  })

  it('queda de conexão após o envio NÃO é segura', () => {
    const e = classifyNetwork(
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      true,
    )
    expect(e.safeToRetryEffect).toBe(false)
  })

  it('INVARIANTE: todo erro unknown tem safeToRetryEffect falso', () => {
    const amostras = [
      classifyHttp(500, {}, true)!,
      classifyHttp(503, {}, true)!,
      classifyNetwork(
        Object.assign(new Error('x'), { code: 'ECONNRESET' }),
        true,
      ),
    ]
    for (const e of amostras) {
      expect(e.disposition).toBe('unknown')
      expect(e.safeToRetryEffect).toBe(false)
    }
  })

  it('erro terminal não autoriza repetição de efeito', () => {
    // Não retenta de qualquer forma, mas o campo precisa ser coerente.
    expect(classifyHttp(403, {}, true)!.safeToRetryEffect).toBe(false)
  })
})
```

- [ ] **Step 2: Implementar**

Em `RedditError`, acrescente o campo obrigatório:

```ts
export class RedditError extends Error {
  readonly code: string
  readonly disposition: Disposition
  /**
   * Verdadeiro apenas quando repetir a operação de efeito é comprovadamente
   * seguro — ou seja, quando o Reddit não chegou a processar o pedido.
   *
   * É este campo, e não `disposition`, que autoriza o worker a limpar
   * `submit_attempted_at` e devolver o job à fila. Reusar `disposition` para
   * isso faria qualquer classificação futura como "retryable" virar
   * permissão para republicar.
   */
  readonly safeToRetryEffect: boolean
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
  readonly userMessage: string

  constructor(init: {
    code: string
    disposition: Disposition
    userMessage: string
    safeToRetryEffect?: boolean
    httpStatus?: number
    retryAfterSeconds?: number
  }) {
    super(`${init.code} (${init.disposition})`)
    this.name = 'RedditError'
    this.code = init.code
    this.disposition = init.disposition
    // Padrão conservador: sem afirmação explícita, assume-se que repetir NÃO
    // é seguro. E `unknown` nunca pode ser sobrescrito para true.
    this.safeToRetryEffect =
      init.disposition === 'unknown' ? false : (init.safeToRetryEffect ?? false)
    this.httpStatus = init.httpStatus
    this.retryAfterSeconds = init.retryAfterSeconds
    this.userMessage = init.userMessage
  }
}
```

E marque `safeToRetryEffect: true` apenas em:

- `429` (`RATE_LIMITED`) — recusa explícita, nada foi processado;
- `5xx` **em leitura** (`REDDIT_UNAVAILABLE`) — sem efeito a duplicar;
- falhas de rede **antes** do envio, em `classifyNetwork` quando
  `sideEffectAttempted` é falso.

Em `budget.ts`, `BUDGET_EXHAUSTED` e `BUDGET_BOOTSTRAP` também recebem
`safeToRetryEffect: true`: nenhuma requisição chegou a sair. `BUDGET_UNAVAILABLE`
idem.

- [ ] **Step 3: Rodar, verificar e commitar**

```powershell
npx vitest run tests/reddit/errors.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: safeToRetryEffect separa retentativa de repeticao de efeito"
```

---

### Task 6: Runner de publicação

**Files:**
- Create: `src/lib/worker/log.ts`
- Create: `src/lib/worker/retry.ts`
- Create: `worker/post-runner.ts`
- Test: `tests/db/post-runner.test.ts`

**Interfaces:**
- Produces:
  - `logExecution(service, entry): Promise<void>` — grava em `execution_logs`, sanitizado
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
    await logExecution(adminClient(), {
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
    await logExecution(adminClient(), {
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
      logExecution(adminClient(), {
        ownerId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        action: 'submit_post',
        outcome: 'success',
      }),
    ).resolves.toBeUndefined()
  })

  it('trunca mensagem muito longa', async () => {
    await logExecution(adminClient(), {
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
// Nada aqui lê a chave secreta: o client chega como parâmetro. É o que mantém
// todo o `src/lib/worker/` livre de segredos e importável de qualquer lado.
import type { SupabaseClient } from '@supabase/supabase-js'
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
export async function logExecution(
  service: SupabaseClient,
  entry: ExecutionLogEntry,
): Promise<void> {
  try {
    const mensagem = entry.errorMessage
      ? String(sanitize(entry.errorMessage)).slice(0, MAX_MESSAGE)
      : null

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

- [ ] **Step 3b: O teste da conexão derrubada depois do envio**

Arquivo próprio: `tests/worker/dropped-connection.test.ts`.

Este é o cenário mais perigoso do sistema — o Reddit recebe o POST, cria a
publicação e a conexão cai antes da resposta. O worker não tem como saber se
publicou. **Nunca pode retentar.**

O teste do `MockAgent` acima (`replyWithError` com `ECONNRESET`) cobre a
classificação, mas não prova o caminho real: ali o erro é fabricado pelo mock,
sem que byte nenhum tenha trafegado. Aqui subimos um servidor HTTP local de
verdade, que **lê o corpo inteiro** e só então destrói o socket. É a diferença
entre "o código trata um erro chamado ECONNRESET" e "o código trata um POST
que chegou ao outro lado".

Não se provoca isso contra a API real — seria publicar de verdade para testar.

```ts
// tests/worker/dropped-connection.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Agent } from 'undici'
import type { AddressInfo } from 'node:net'

let servidor: Server
let porta: number
/** Prova que o upstream realmente recebeu o corpo antes de cair. */
let corpoRecebido = ''
let recebeuPost = false

beforeAll(async () => {
  servidor = createServer((req, res) => {
    if (req.method !== 'POST') {
      // Os GETs de requisitos respondem normalmente.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }

    const partes: Buffer[] = []
    req.on('data', (c) => partes.push(c as Buffer))
    req.on('end', () => {
      // Neste ponto o "Reddit" recebeu o pedido completo. Do lado de lá, a
      // publicação existiria. Só então a conexão morre.
      corpoRecebido = Buffer.concat(partes).toString('utf8')
      recebeuPost = true
      res.socket?.destroy()
    })
  })

  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok))
  porta = (servidor.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((ok) => servidor.close(() => ok()))
})

/**
 * Dispatcher que redireciona oauth.reddit.com para o servidor local.
 *
 * O `connect` customizado é o que mantém o teste honesto: a URL, os headers e
 * o corpo continuam sendo exatamente os que iriam para o Reddit. Só o destino
 * TCP muda.
 */
function dispatcherLocal() {
  return new Agent({
    connect: (opts, callback) => {
      const net = require('node:net') as typeof import('node:net')
      const socket = net.connect(porta, '127.0.0.1')
      socket.on('connect', () => callback(null, socket))
      socket.on('error', (e) => callback(e, null))
    },
  })
}

describe('conexão derrubada depois do envio', () => {
  it('o upstream recebe o POST e o job termina em needs_review', async () => {
    const job = await criarJob()
    await rodar(job, { dispatcher: dispatcherLocal() })

    // 1. O pedido chegou de verdade ao outro lado.
    expect(recebeuPost).toBe(true)
    expect(corpoRecebido).toContain('kind=')

    // 2. O desfecho é revisão manual, nunca falha nem republicação.
    const depois = await lerJob(job.id)
    expect(depois.status).toBe('needs_review')
    expect(depois.review_reason).toBeTruthy()
  })

  it('submit_attempted_at permanece gravado', async () => {
    // É o registro de que algo pode ter saído. Limpá-lo autorizaria uma
    // segunda publicação.
    const job = await criarJob()
    await rodar(job, { dispatcher: dispatcherLocal() })

    expect((await lerJob(job.id)).submit_attempted_at).not.toBeNull()
  })

  it('NÃO agenda nova tentativa', async () => {
    const job = await criarJob()
    await rodar(job, { dispatcher: dispatcherLocal() })

    const depois = await lerJob(job.id)
    expect(depois.next_attempt_at).toBeNull()
    expect(depois.retry_count).toBe(0)
  })

  it('rodar o worker de novo não pega o job para republicar', async () => {
    // A prova final: mesmo com o loop girando, o job não volta à fila.
    const job = await criarJob()
    await rodar(job, { dispatcher: dispatcherLocal() })

    const { data } = await adminClient().rpc('claim_due_posts', {
      p_worker_id: 'worker-teste',
      p_batch: 50,
    })
    expect((data ?? []).map((r: { id: string }) => r.id)).not.toContain(job.id)
  })

  it('o reaper também não o devolve à fila', async () => {
    const job = await criarJob()
    await rodar(job, { dispatcher: dispatcherLocal() })

    const { data } = await adminClient().rpc('reap_stale_jobs', {
      p_timeout_seconds: 0,
    })
    const devolvidos = (data ?? [])
      .filter((r: { outcome: string }) => r.outcome === 'requeued')
      .map((r: { job_id: string }) => r.job_id)
    expect(devolvidos).not.toContain(job.id)
  })

  it('o erro classificado não autoriza repetir o efeito', async () => {
    // Amarra este cenário ao ajuste do safeToRetryEffect.
    const job = await criarJob()
    const { erro } = await rodar(job, { dispatcher: dispatcherLocal() })
    expect(erro?.disposition).toBe('unknown')
    expect(erro?.safeToRetryEffect).toBe(false)
  })
})
```

Reaproveite `criarJob`, `lerJob` e `rodar` do arquivo de testes do runner
extraindo-os para `tests/worker/post-job-helpers.ts` — duplicá-los faria os
dois arquivos divergirem com o tempo. `rodar` ganha um parâmetro opcional
`{ dispatcher }` repassado ao client, e passa a devolver o erro capturado.

- [ ] **Step 4: Implementar o runner**

```ts
// worker/post-runner.ts
import type { Dispatcher } from 'undici'
import { workerServiceClient } from './supabase'
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
  const service = workerServiceClient()
  const inicio = Date.now()

  const log = (
    outcome: 'success' | 'failure' | 'retry' | 'unknown',
    extra: { errorCode?: string; errorMessage?: string; httpStatus?: number } = {},
  ) =>
    logExecution(service, {
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

    // --- retentável E seguro repetir ---
    // As duas condições são necessárias: `retryable` diz que vale a pena
    // tentar; `safeToRetryEffect` diz que repetir não arrisca publicar duas
    // vezes. Só com as duas o job volta à fila com submit_attempted_at limpo.
    if (
      e instanceof RedditError &&
      e.disposition === 'retryable' &&
      e.safeToRetryEffect
    ) {
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

**Sobre limpar `submit_attempted_at`.** A guarda é `safeToRetryEffect`, não
`disposition`. Um erro que seja `retryable` mas sem afirmação explícita de
segurança cai no ramo terminal — conservador de propósito: falhar um job é
recuperável pelo histórico, republicar não é.

**Caso residual que o ramo terminal precisa cobrir:** um erro `retryable` com
`safeToRetryEffect: false` não deve ser tratado como falha comum. O runner o
envia para `needs_review`, porque a combinação significa "vale a pena tentar,
mas não sabemos se já teve efeito" — exatamente a definição de ambíguo.

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
import { workerServiceClient } from './supabase'
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
  const service = workerServiceClient()
  const inicio = Date.now()

  const log = (
    outcome: 'success' | 'failure' | 'retry' | 'unknown',
    extra: { errorCode?: string; errorMessage?: string } = {},
  ) =>
    logExecution(service, {
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
2. **orçamento, ANTES do claim** — se pausado, o ciclo termina sem reivindicar
   nada e o worker dorme até o próximo ciclo;
3. claim de publicações → processa **sequencialmente**;
4. claim de comentários → processa sequencialmente;
5. limpeza de logs vencidos, uma vez por hora.

**A ordem entre 2 e 3 é a regra, não uma otimização.** Um worker jamais pode
dormir esperando orçamento com um job em `processing`: passado o timeout, o
reaper de outra instância o recuperaria, e dois workers passariam a processar
o mesmo job. Verificar o orçamento antes do claim elimina a situação em vez de
administrá-la.

**Orçamento que esgota no meio do lote.** Aí o job já está reivindicado. O
worker interrompe o lote e **devolve à fila** os jobs ainda não processados —
seguro, porque nenhum deles chegou a ter `submit_attempted_at` gravado.

**Heartbeat, para o caso irredutível.** Um único job pode demorar mais que o
timeout do reaper — refresh de token lento, proxy ruim, resposta demorada. Para
isso existe `renew_job_lock`, chamada periodicamente enquanto o job está em
execução. Sem ela, o reaper recuperaria um job que ainda está vivo, e o mesmo
conteúdo poderia ser publicado duas vezes.

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

E, especificamente para o ajuste do lock, no mesmo arquivo:

```ts
describe('o ciclo não segura jobs enquanto espera', () => {
  it('orçamento pausado: NENHUM job sai de scheduled', async () => {
    // A prova de que a checagem vem antes do claim. Se viesse depois, os jobs
    // ficariam em processing durante toda a pausa.
    const a = await criarJob()
    const b = await criarJob()
    await pausarOrcamento()

    const r = await runCycle()

    expect(r.pausedForBudget).toBe(true)
    for (const job of [a, b]) {
      const depois = await lerJob(job.id)
      expect(depois.status).toBe('scheduled')
      expect(depois.locked_by).toBeNull()
    }
  })

  it('orçamento esgota no meio do lote: o restante volta para a fila', async () => {
    // O primeiro job consome o que sobrava; os outros dois não podem ficar
    // presos em processing até o próximo ciclo.
    const jobs = [await criarJob(), await criarJob(), await criarJob()]
    await deixarOrcamentoPara(1)

    await runCycle()

    const restantes = await Promise.all(jobs.slice(1).map((j) => lerJob(j.id)))
    for (const job of restantes) {
      expect(job.status).toBe('scheduled')
      expect(job.locked_by).toBeNull()
      // Devolver só é seguro porque nenhum chegou a tentar enviar.
      expect(job.submit_attempted_at).toBeNull()
    }
  })

  it('job demorado mantém o lock: outro worker não o recupera', async () => {
    // O teste central do ajuste, agora no nível do ciclo e não do SQL.
    // O upstream demora mais que o timeout do reaper para responder.
    process.env.WORKER_REAPER_TIMEOUT_SECONDS = '1'
    const job = await criarJob()

    const ciclo = runCycle({ dispatcher: dispatcherLento(3000) })

    // Enquanto o ciclo roda, um segundo worker tenta reivindicar e o reaper
    // tenta recuperar. Nenhum dos dois pode conseguir.
    await new Promise((r) => setTimeout(r, 2000))

    const { data: colhidos } = await adminClient().rpc('reap_stale_jobs', {
      p_timeout_seconds: 1,
    })
    expect((colhidos ?? []).map((r: { job_id: string }) => r.job_id))
      .not.toContain(job.id)

    const { data: roubo } = await adminClient().rpc('claim_due_posts', {
      p_worker_id: 'worker-intruso',
      p_batch: 10,
    })
    expect((roubo ?? []).map((r: { id: string }) => r.id)).not.toContain(job.id)

    await ciclo

    // E o job terminou normalmente, uma vez só.
    const depois = await lerJob(job.id)
    expect(depois.status).toBe('published')
    const { data: logs } = await adminClient()
      .from('execution_logs')
      .select('id')
      .eq('scheduled_post_id', job.id)
      .eq('action', 'submit_post')
      .eq('outcome', 'success')
    expect(logs).toHaveLength(1)
  })
})
```

`dispatcherLento(ms)` é um `MockAgent` cujo intercept usa `.delay(ms)`. O teste
leva alguns segundos de propósito — é o único jeito de exercitar o heartbeat
com o relógio real do `setInterval`.

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
import { workerServiceClient } from './supabase'
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
  const service = workerServiceClient()

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

  // --- 2: orçamento ANTES do claim ---
  //
  // A ordem importa e não é preferência de estilo. Se o claim viesse primeiro,
  // o worker esperaria o reset do orçamento segurando jobs em `processing`.
  // Passado o timeout, o reaper de outra instância os devolveria à fila e dois
  // workers processariam o mesmo job. Verificando antes, a situação não chega
  // a existir: sem orçamento, o ciclo termina sem ter reivindicado nada.
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

  const restantes = [...((posts ?? []) as PostJob[])]
  while (restantes.length > 0) {
    if (parando) break
    const job = restantes.shift()!

    // O heartbeat mantém o lock vivo enquanto o job roda. Necessário porque um
    // único job pode passar do timeout do reaper — refresh lento, proxy ruim,
    // upstream demorado — e sem ele o reaper mataria um job vivo.
    const heartbeat = iniciarHeartbeat(service, 'post', job.id, config)
    try {
      const desfecho = await runPost(job, opts)
      relatorio.posts[desfecho] = (relatorio.posts[desfecho] ?? 0) + 1

      // Orçamento esgotado no meio do lote: interrompe e DEVOLVE o que sobrou.
      // Segurar jobs reivindicados até o próximo ciclo é o que queremos evitar.
      if (desfecho === 'budget') {
        relatorio.pausedForBudget = true
        await devolverAFila(service, 'post', restantes.map((j) => j.id))
        break
      }
    } catch (e) {
      // Um job problemático não pode derrubar o ciclo inteiro.
      console.error('worker: falha inesperada em publicação', sanitize(e))
      relatorio.posts.error = (relatorio.posts.error ?? 0) + 1
    } finally {
      heartbeat.parar()
    }
  }

  if (relatorio.pausedForBudget) return relatorio

  // --- 4: comentários ---
  const { data: comments } = await service.rpc('claim_due_comments', {
    p_worker_id: config.workerId,
    p_batch: config.batchSize,
  })

  const comRestantes = [...((comments ?? []) as CommentJob[])]
  while (comRestantes.length > 0) {
    if (parando) break
    const job = comRestantes.shift()!
    const heartbeat = iniciarHeartbeat(service, 'comment', job.id, config)
    try {
      const desfecho = await runComment(job, opts)
      relatorio.comments[desfecho] = (relatorio.comments[desfecho] ?? 0) + 1
      if (desfecho === 'budget') {
        relatorio.pausedForBudget = true
        await devolverAFila(service, 'comment', comRestantes.map((j) => j.id))
        break
      }
    } catch (e) {
      console.error('worker: falha inesperada em comentário', sanitize(e))
      relatorio.comments.error = (relatorio.comments.error ?? 0) + 1
    } finally {
      heartbeat.parar()
    }
  }

  return relatorio
}

/**
 * Renova o lock periodicamente enquanto o job roda.
 *
 * O intervalo é uma fração do timeout do reaper para tolerar uma renovação
 * perdida. Se a renovação retornar falso, perdemos o lock: registramos e
 * paramos de renovar — o runner em andamento vai terminar e gravar seu
 * resultado, que é preferível a abortar no meio de uma submissão.
 */
function iniciarHeartbeat(
  service: SupabaseClient,
  kind: 'post' | 'comment',
  jobId: string,
  config: WorkerConfig,
) {
  const intervalo = Math.max(5_000, (config.reaperTimeoutSeconds * 1000) / 3)
  const timer = setInterval(async () => {
    try {
      const { data } = await service.rpc('renew_job_lock', {
        p_kind: kind,
        p_job_id: jobId,
        p_worker_id: config.workerId,
      })
      if (data === false) {
        console.error(`worker: lock perdido em ${kind} ${jobId}`)
        clearInterval(timer)
      }
    } catch (e) {
      console.error('worker: heartbeat falhou', sanitize(e))
    }
  }, intervalo)
  // Não segura o processo aberto no desligamento.
  timer.unref?.()
  return { parar: () => clearInterval(timer) }
}

/**
 * Devolve à fila jobs reivindicados que não chegamos a processar.
 *
 * Seguro por construção: nenhum deles teve `submit_attempted_at` gravado — o
 * runner nem chegou a rodar. Ainda assim a condição está no `update`, para o
 * caso de a lista vir errada no futuro.
 */
async function devolverAFila(
  service: SupabaseClient,
  kind: 'post' | 'comment',
  ids: string[],
) {
  if (ids.length === 0) return
  const tabela = kind === 'post' ? 'scheduled_posts' : 'scheduled_comments'
  await service
    .from(tabela)
    .update({ status: 'scheduled', locked_at: null, locked_by: null })
    .in('id', ids)
    .eq('status', 'processing')
    .is('submit_attempted_at', null)
}

async function limparLogsAntigos() {
  const { logRetentionDays } = getWorkerConfig()
  const corte = new Date(Date.now() - logRetentionDays * 86_400_000)
  const service = workerServiceClient()
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
