# Plano 5 — Parte B: Submissão, Runners e Loop do Worker

> Continuação de `2026-08-16-plano-5-worker-e-visualizacao.md`. As Global
> Constraints daquele arquivo valem integralmente aqui.

Tasks 3 a 9 fecham o **Bloco A** (worker publicando de verdade). As Tasks 10 a
15 estão em `2026-08-16-plano-5d-paginas.md`.

---

### Task 3: Submissão de publicação

**Files:**
- Create: `src/lib/reddit/posts.ts`
- Test: `tests/reddit/posts.test.ts`

**Interfaces:**
- Consumes: `RedditClient`, `BuiltPayload`
- Produces:
  - `type SubmitResult` — `{ redditPostId, redditFullname, permalink }`
  - `submitPost(client, opts): Promise<SubmitResult>`

**Formato confirmado na documentação:** `POST /api/submit` responde
`{"json": {"errors": [], "data": {"url", "id", "name"}}}`, onde `name` é o
fullname (`t3_abc`) e `id` é o id36 (`abc`).

**Marcação obrigatória:** a chamada usa `hasSideEffect: true`. É isso que faz
o cliente classificar 5xx e queda de conexão como `unknown` em vez de
retentável — a regra da revisão 2 da spec.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/reddit/posts.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { submitPost } from '@/lib/reddit/posts'

let agent: MockAgent

beforeEach(() => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
})

afterEach(async () => {
  await agent.close()
})

const pool = () => agent.get('https://oauth.reddit.com')
const submitPath = (p: string) => p.startsWith('/api/submit')
const client = () => createRedditClient({ accessToken: 'AT', dispatcher: agent })

const sucesso = {
  json: {
    errors: [],
    data: {
      id: 'abc123',
      name: 't3_abc123',
      url: 'https://www.reddit.com/r/minhacomunidade/comments/abc123/titulo/',
    },
  },
}

const payloadLink = {
  subredditName: 'minhacomunidade',
  postKind: 'link' as const,
  title: 'Meu título',
  url: 'https://exemplo.com/v',
  body: null,
  flairId: null,
  nsfw: false,
  spoiler: false,
}

describe('submitPost', () => {
  it('envia link post com kind=link e url', async () => {
    let corpo = ''
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return sucesso
      })

    await submitPost(client(), payloadLink)

    expect(corpo).toContain('kind=link')
    expect(corpo).toContain('sr=minhacomunidade')
    expect(corpo).toContain('url=https%3A%2F%2Fexemplo.com%2Fv')
    expect(corpo).not.toContain('text=')
  })

  it('envia self post com kind=self e text', async () => {
    let corpo = ''
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return sucesso
      })

    await submitPost(client(), {
      ...payloadLink,
      postKind: 'self',
      url: null,
      body: 'meu texto',
    })

    expect(corpo).toContain('kind=self')
    expect(corpo).toContain('text=meu+texto')
    expect(corpo).not.toContain('url=')
  })

  it('devolve id, fullname e permalink', async () => {
    pool().intercept({ path: submitPath, method: 'POST' }).reply(200, sucesso)

    const r = await submitPost(client(), payloadLink)
    expect(r).toEqual({
      redditPostId: 'abc123',
      redditFullname: 't3_abc123',
      permalink:
        'https://www.reddit.com/r/minhacomunidade/comments/abc123/titulo/',
    })
  })

  it('envia flair quando informado', async () => {
    let corpo = ''
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return sucesso
      })

    await submitPost(client(), { ...payloadLink, flairId: 'flair-abc' })
    expect(corpo).toContain('flair_id=flair-abc')
  })

  it('omite flair quando não informado', async () => {
    let corpo = ''
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return sucesso
      })

    await submitPost(client(), payloadLink)
    expect(corpo).not.toContain('flair_id')
  })

  it('envia nsfw e spoiler quando marcados', async () => {
    let corpo = ''
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return sucesso
      })

    await submitPost(client(), { ...payloadLink, nsfw: true, spoiler: true })
    expect(corpo).toContain('nsfw=true')
    expect(corpo).toContain('spoiler=true')
  })

  it('marca a requisição como tendo efeito colateral', async () => {
    // Consequência: 5xx vira unknown, não retentável.
    pool().intercept({ path: submitPath, method: 'POST' }).reply(503, {})

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
    })
  })

  it('queda de conexão vira resultado desconhecido', async () => {
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      disposition: 'unknown',
    })
  })

  it('200 com json.errors vira erro terminal', async () => {
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, {
        json: { errors: [['SUBREDDIT_NOTALLOWED', 'não permitido', 'sr']] },
      })

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      disposition: 'terminal',
    })
  })

  it('resposta sem fullname é tratada como resultado desconhecido', async () => {
    // Sem o fullname não há como comentar nem registrar o permalink; e como o
    // post pode ter sido criado, retentar seria arriscado.
    pool()
      .intercept({ path: submitPath, method: 'POST' })
      .reply(200, { json: { errors: [], data: {} } })

    await expect(submitPost(client(), payloadLink)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    })
  })
})
```

- [ ] **Step 2: Implementar**

```ts
// src/lib/reddit/posts.ts
import type { RedditClient } from './client'
import { RedditError } from './errors'

export type SubmitPostInput = {
  subredditName: string
  postKind: 'link' | 'self'
  title: string
  url: string | null
  body: string | null
  flairId: string | null
  nsfw: boolean
  spoiler: boolean
}

export type SubmitResult = {
  redditPostId: string
  redditFullname: string
  permalink: string | null
}

type SubmitResponse = {
  json?: { data?: { id?: string; name?: string; url?: string } }
}

/**
 * Publica na comunidade.
 *
 * `hasSideEffect: true` é obrigatório: é o que faz o cliente classificar 5xx
 * e queda de conexão como resultado desconhecido, em vez de retentável.
 * Retentar às cegas aqui publicaria duas vezes.
 */
export async function submitPost(
  client: RedditClient,
  input: SubmitPostInput,
): Promise<SubmitResult> {
  const form: Record<string, string> = {
    sr: input.subredditName,
    kind: input.postKind,
    title: input.title,
    resubmit: 'true',
    sendreplies: 'false',
  }

  if (input.postKind === 'link' && input.url) {
    form.url = input.url
  } else if (input.postKind === 'self') {
    form.text = input.body ?? ''
  }

  if (input.flairId) form.flair_id = input.flairId
  if (input.nsfw) form.nsfw = 'true'
  if (input.spoiler) form.spoiler = 'true'

  const { data } = await client.request<SubmitResponse>({
    path: '/api/submit',
    method: 'POST',
    form,
    hasSideEffect: true,
  })

  const fullname = data?.json?.data?.name
  const id = data?.json?.data?.id

  if (typeof fullname !== 'string' || typeof id !== 'string') {
    // O Reddit respondeu 200 sem identificar a publicação. Ela pode existir,
    // então não é seguro retentar.
    throw new RedditError({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
      userMessage:
        'O Reddit aceitou a publicação mas não devolveu o identificador. É preciso conferir manualmente se ela foi criada.',
    })
  }

  return {
    redditPostId: id,
    redditFullname: fullname,
    permalink: typeof data?.json?.data?.url === 'string'
      ? data.json.data.url
      : null,
  }
}
```

- [ ] **Step 3: Rodar, verificar e commitar**

```powershell
npx vitest run tests/reddit/posts.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: submissao de publicacao no reddit"
```

---

### Task 4: Submissão de comentário

**Files:**
- Create: `src/lib/reddit/comments.ts`
- Test: `tests/reddit/comments.test.ts`

**Interfaces:**
- Produces: `submitComment(client, { thingId, body }): Promise<CommentResult>`

**Formato confirmado:** `POST /api/comment` responde
`{"json": {"errors": [], "data": {"things": [{"kind": "t1", "data": {"id", "name", "permalink"}}]}}}`.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/reddit/comments.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { submitComment } from '@/lib/reddit/comments'

let agent: MockAgent

beforeEach(() => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
})

afterEach(async () => {
  await agent.close()
})

const pool = () => agent.get('https://oauth.reddit.com')
const commentPath = (p: string) => p.startsWith('/api/comment')
const client = () => createRedditClient({ accessToken: 'AT', dispatcher: agent })

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
            permalink: '/r/com/comments/abc/titulo/cmt1/',
          },
        },
      ],
    },
  },
}

describe('submitComment', () => {
  it('envia thing_id e text', async () => {
    let corpo = ''
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return sucesso
      })

    await submitComment(client(), {
      thingId: 't3_abc123',
      body: 'meu comentário',
    })

    expect(corpo).toContain('thing_id=t3_abc123')
    expect(corpo).toContain('text=meu+coment')
  })

  it('devolve id, fullname e permalink', async () => {
    pool().intercept({ path: commentPath, method: 'POST' }).reply(200, sucesso)

    const r = await submitComment(client(), {
      thingId: 't3_abc123',
      body: 'texto',
    })
    expect(r).toEqual({
      redditCommentId: 'cmt1',
      redditFullname: 't1_cmt1',
      permalink: '/r/com/comments/abc/titulo/cmt1/',
    })
  })

  it('marca a requisição como tendo efeito colateral', async () => {
    pool().intercept({ path: commentPath, method: 'POST' }).reply(502, {})

    await expect(
      submitComment(client(), { thingId: 't3_abc', body: 'x' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'unknown' })
  })

  it('200 com json.errors vira erro terminal', async () => {
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, { json: { errors: [['DELETED_LINK', 'post removido']] } })

    await expect(
      submitComment(client(), { thingId: 't3_abc', body: 'x' }),
    ).rejects.toMatchObject({ disposition: 'terminal' })
  })

  it('resposta sem things vira resultado desconhecido', async () => {
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, { json: { errors: [], data: { things: [] } } })

    await expect(
      submitComment(client(), { thingId: 't3_abc', body: 'x' }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
  })

  it('permalink ausente não impede o sucesso', async () => {
    pool()
      .intercept({ path: commentPath, method: 'POST' })
      .reply(200, {
        json: {
          errors: [],
          data: { things: [{ kind: 't1', data: { id: 'c1', name: 't1_c1' } }] },
        },
      })

    const r = await submitComment(client(), { thingId: 't3_abc', body: 'x' })
    expect(r.redditCommentId).toBe('c1')
    expect(r.permalink).toBeNull()
  })
})
```

- [ ] **Step 2: Implementar**

```ts
// src/lib/reddit/comments.ts
import type { RedditClient } from './client'
import { RedditError } from './errors'

export type SubmitCommentInput = {
  /** Fullname do post pai, ex.: t3_abc123. */
  thingId: string
  body: string
}

export type CommentResult = {
  redditCommentId: string
  redditFullname: string
  permalink: string | null
}

type CommentResponse = {
  json?: {
    data?: {
      things?: { data?: { id?: string; name?: string; permalink?: string } }[]
    }
  }
}

/**
 * Comenta em uma publicação já existente.
 *
 * Como em submitPost, `hasSideEffect: true` é obrigatório: um comentário
 * duplicado é tão indesejado quanto uma publicação duplicada.
 */
export async function submitComment(
  client: RedditClient,
  input: SubmitCommentInput,
): Promise<CommentResult> {
  const { data } = await client.request<CommentResponse>({
    path: '/api/comment',
    method: 'POST',
    form: { thing_id: input.thingId, text: input.body },
    hasSideEffect: true,
  })

  const thing = data?.json?.data?.things?.[0]?.data
  const id = thing?.id
  const fullname = thing?.name

  if (typeof id !== 'string' || typeof fullname !== 'string') {
    throw new RedditError({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
      userMessage:
        'O Reddit aceitou o comentário mas não devolveu o identificador. É preciso conferir manualmente se ele foi publicado.',
    })
  }

  return {
    redditCommentId: id,
    redditFullname: fullname,
    permalink: typeof thing?.permalink === 'string' ? thing.permalink : null,
  }
}
```

- [ ] **Step 3: Rodar, verificar e commitar**

```powershell
npx vitest run tests/reddit/comments.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: submissao de comentario no reddit"
```

---

### Task 5: Infraestrutura do worker

**Files:**
- Create: `src/lib/supabase/service-client.ts`
- Modify: `src/lib/supabase/admin.ts`
- Create: `src/lib/worker/load-account.ts`
- Create: `src/lib/worker/consistency.ts`
- Create: `worker/tsconfig.json`
- Test: `tests/worker/consistency.test.ts`
- Test: `tests/db/load-account.test.ts`

**Interfaces:**
- Produces:
  - `createServiceClient()` — client `service_role` sem `server-only`
  - `loadAccountForWorker(accountId): Promise<VerifiedAccount>`
  - `assertJobConsistency(job): void` — lança `InconsistentOwnershipError`

**O problema a resolver.** O worker é um processo Node comum, fora do Next.
Ele não pode importar `src/lib/supabase/admin.ts`, que declara
`import 'server-only'` — esse pacote lança fora do ambiente de servidor React.
Tampouco pode usar `assertAccountAccess`, que depende de sessão HTTP.

**A solução, sem afrouxar nada:** extrair a criação do client para
`service-client.ts` (sem a marca), e manter `admin.ts` como um invólucro que
declara `server-only` e reexporta. O Next continua protegido contra import em
Client Component; o worker importa o módulo base.

A autorização, no worker, não vem de sessão — vem de o job já estar no banco
com `owner_id` coerente, garantido por FKs compostas. `assertJobConsistency`
é defesa em profundidade contra uma migration futura mal feita.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/worker/consistency.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  assertJobConsistency,
  InconsistentOwnershipError,
} from '@/lib/worker/consistency'

const coerente = {
  postOwnerId: 'u1',
  accountOwnerId: 'u1',
  subredditOwnerId: 'u1',
  postAccountId: 'a1',
  subredditAccountId: 'a1',
}

describe('assertJobConsistency', () => {
  it('aceita job coerente', () => {
    expect(() => assertJobConsistency(coerente)).not.toThrow()
  })

  it('recusa owner divergente entre post e conta', () => {
    expect(() =>
      assertJobConsistency({ ...coerente, accountOwnerId: 'u2' }),
    ).toThrow(InconsistentOwnershipError)
  })

  it('recusa owner divergente entre post e comunidade', () => {
    expect(() =>
      assertJobConsistency({ ...coerente, subredditOwnerId: 'u2' }),
    ).toThrow(InconsistentOwnershipError)
  })

  it('recusa comunidade que não é da conta do post', () => {
    expect(() =>
      assertJobConsistency({ ...coerente, subredditAccountId: 'a2' }),
    ).toThrow(InconsistentOwnershipError)
  })

  it('a mensagem não vaza identificadores em claro', () => {
    try {
      assertJobConsistency({ ...coerente, accountOwnerId: 'u2' })
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).not.toContain('u1')
      expect((e as Error).message).not.toContain('u2')
    }
  })
})

describe('separação entre admin e service client', () => {
  it('admin.ts continua marcado como server-only', () => {
    const src = readFileSync('src/lib/supabase/admin.ts', 'utf8')
    expect(src).toContain("import 'server-only'")
  })

  it('service-client.ts NÃO é server-only, para o worker poder importar', () => {
    const src = readFileSync('src/lib/supabase/service-client.ts', 'utf8')
    expect(src).not.toContain("import 'server-only'")
  })

  it('service-client.ts nunca usa variável NEXT_PUBLIC_ para a chave secreta', () => {
    const src = readFileSync('src/lib/supabase/service-client.ts', 'utf8')
    expect(src).toContain('SUPABASE_SECRET_KEY')
    expect(src).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SECRET/)
  })

  it('nenhum componente de cliente importa o service client', () => {
    for (const arquivo of [
      'src/components/posts/new-post-form.tsx',
      'src/components/accounts/network-form.tsx',
      'src/components/communities/sync-button.tsx',
    ]) {
      const src = readFileSync(arquivo, 'utf8')
      expect(src).toContain("'use client'")
      expect(src).not.toContain('service-client')
      expect(src).not.toContain('createServiceClient')
    }
  })
})
```

- [ ] **Step 2: Implementar a separação de clients**

```ts
// src/lib/supabase/service-client.ts
import { createClient } from '@supabase/supabase-js'
import { getCoreEnv } from '@/lib/config/env'

/**
 * Client com a chave secreta: IGNORA RLS por completo.
 *
 * Este módulo NÃO declara `server-only` de propósito — o worker é um processo
 * Node comum, fora do Next, e aquele pacote lança fora do ambiente de
 * servidor React. Para uso dentro do Next, importe `admin.ts`, que declara a
 * marca e reexporta daqui.
 *
 * Nunca importe este arquivo de um Client Component. Há teste verificando.
 */
export function createServiceClient() {
  const env = getCoreEnv()
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
```

```ts
// src/lib/supabase/admin.ts
import 'server-only'
import { createServiceClient } from './service-client'

/**
 * Client com a chave secreta para uso dentro do Next: IGNORA RLS.
 *
 * Nunca chame isto com um id vindo do cliente sem antes confirmar a posse do
 * recurso — use os helpers de src/lib/auth/ownership.ts.
 */
export function createAdminSupabase() {
  return createServiceClient()
}
```

- [ ] **Step 3: Implementar a checagem de consistência**

```ts
// src/lib/worker/consistency.ts
export type JobOwnership = {
  postOwnerId: string
  accountOwnerId: string
  subredditOwnerId: string
  postAccountId: string
  subredditAccountId: string
}

export class InconsistentOwnershipError extends Error {
  constructor() {
    // Sem identificadores na mensagem: ela vai para log.
    super(
      'Job com vínculos inconsistentes entre publicação, conta e comunidade.',
    )
    this.name = 'InconsistentOwnershipError'
  }
}

/**
 * Confere que publicação, conta e comunidade pertencem ao mesmo dono, e que a
 * comunidade é da conta escolhida.
 *
 * As FKs compostas já tornam isso impossível no banco. Esta função é defesa
 * em profundidade contra uma migration futura que as afrouxe: antes de
 * publicar em nome de alguém, o worker confirma de novo.
 */
export function assertJobConsistency(job: JobOwnership): void {
  const mesmoDono =
    job.postOwnerId === job.accountOwnerId &&
    job.postOwnerId === job.subredditOwnerId
  const comunidadeDaConta = job.postAccountId === job.subredditAccountId

  if (!mesmoDono || !comunidadeDaConta) {
    throw new InconsistentOwnershipError()
  }
}
```

- [ ] **Step 4: Implementar o carregamento de conta**

```ts
// src/lib/worker/load-account.ts
import { createServiceClient } from '@/lib/supabase/service-client'
import type { VerifiedAccount } from '@/lib/auth/ownership'

export class AccountUnavailableError extends Error {
  constructor(status: string) {
    super(`A conta não está disponível para publicar (situação: ${status}).`)
    this.name = 'AccountUnavailableError'
  }
}

/**
 * Carrega a conta de um job para o worker.
 *
 * No worker não existe sessão: a autorização vem de o job já estar no banco
 * com owner_id coerente, garantido por FKs compostas e reconferido por
 * assertJobConsistency. Por isso o tipo VerifiedAccount é produzido aqui sem
 * passar por assertAccountAccess, que depende de requisição HTTP.
 */
export async function loadAccountForWorker(
  accountId: string,
): Promise<VerifiedAccount> {
  const service = createServiceClient()
  const { data, error } = await service
    .from('reddit_accounts')
    .select(
      'id, owner_id, reddit_user_id, username, scopes, status, min_interval_seconds, last_submit_at',
    )
    .eq('id', accountId)
    .single()

  if (error || !data) {
    throw new AccountUnavailableError('não encontrada')
  }
  if (data.status !== 'connected') {
    throw new AccountUnavailableError(data.status)
  }

  return data as VerifiedAccount
}
```

- [ ] **Step 5: Escrever o teste de carregamento**

```ts
// tests/db/load-account.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import {
  AccountUnavailableError,
  loadAccountForWorker,
} from '@/lib/worker/load-account'

let userA: { id: string; accessToken: string }
let conta: string

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`la-${stamp}@teste.local`)

  const { data } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_la_${stamp}`,
      username: 'conta_worker',
    })
    .select('id')
    .single()
  conta = data!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('loadAccountForWorker', () => {
  it('carrega a conta conectada com o owner correto', async () => {
    const c = await loadAccountForWorker(conta)
    expect(c.id).toBe(conta)
    expect(c.owner_id).toBe(userA.id)
  })

  it('recusa conta inexistente', async () => {
    await expect(
      loadAccountForWorker('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    ).rejects.toBeInstanceOf(AccountUnavailableError)
  })

  it('recusa conta desconectada', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', conta)

    await expect(loadAccountForWorker(conta)).rejects.toBeInstanceOf(
      AccountUnavailableError,
    )

    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'connected' })
      .eq('id', conta)
  })

  it('a mensagem explica a situação sem jargão', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'revoked' })
      .eq('id', conta)

    try {
      await loadAccountForWorker(conta)
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).toMatch(/não está disponível/i)
    } finally {
      await adminClient()
        .from('reddit_accounts')
        .update({ status: 'connected' })
        .eq('id', conta)
    }
  })
})
```

- [ ] **Step 6: Configurar o TypeScript do worker**

```json
// worker/tsconfig.json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "types": ["node"],
    "paths": {
      "@/*": ["../src/*"]
    }
  },
  "include": ["./**/*.ts", "../src/lib/**/*.ts"]
}
```

- [ ] **Step 7: Rodar, verificar e commitar**

```powershell
npx vitest run tests/worker tests/db/load-account.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: infraestrutura do worker separada do runtime do next"
```

---

## Continua

Tasks 6 a 9 (runner de publicação, runner de comentário, loop e Docker) em
`2026-08-16-plano-5c-runners-e-loop.md`; Tasks 10 a 15 (páginas) em
`2026-08-16-plano-5d-paginas.md`.
