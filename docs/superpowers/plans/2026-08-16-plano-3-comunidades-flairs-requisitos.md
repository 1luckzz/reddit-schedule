# Reddit Post Scheduler — Plano 3: Comunidades, Flairs e Requisitos de Publicação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sincronizar as comunidades que cada conta modera, ler os flairs disponíveis e os requisitos de publicação de cada uma — a base de dados que o formulário de nova publicação (Plano 4) consome para validar antes de agendar.

**Architecture:** Três leituras da API oficial (`/subreddits/mine/moderator`, `/r/{sub}/api/link_flair_v2`, `/api/v1/{sub}/post_requirements`) atrás do cliente HTTP já existente. As comunidades são persistidas e nunca editáveis pelo usuário: nascem e morrem pela sincronização. Flairs e requisitos são lidos sob demanda, sem persistência, porque mudam sem aviso. Este plano também introduz o orçamento global de rate limit, porque a sincronização é a primeira funcionalidade que faz várias chamadas em sequência.

**Tech Stack:** as dos Planos 1 e 2. Nenhuma dependência nova.

**Spec:** `docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md` (revisão 2, aprovada)

**Planos anteriores:** 1 (fundação e auth) e 2 (OAuth e contas) — concluídos.

**Fase da spec coberta:** 3. A seção 12.3 (coordenador global de rate limit) é antecipada da Fase 5, pelo motivo explicado na Task 2.

## Global Constraints

As dos Planos 1 e 2 continuam valendo integralmente. Estas se somam:

- **Credenciais do Reddit permanecem apenas em `.env.local`.** Nenhum teste usa credenciais reais; a API é simulada com `undici.MockAgent` e a suíte passa sem `REDDIT_CLIENT_ID`.
- **Comunidades são dados espelhados da API, não entrada do usuário.** `authenticated` recebe apenas `SELECT` sobre `subreddits`; nada de INSERT, UPDATE ou DELETE pelo Data API.
- **Nenhuma leitura inventa campo.** O parsing aceita apenas os campos documentados, com fallback defensivo onde a API é conhecidamente inconsistente (`over18` vs `over_18`).
- **Toda chamada à API alimenta o orçamento de rate limit** a partir dos headers `X-Ratelimit-*`, que são a fonte operacional de verdade.
- **Paginação sempre com teto.** Nenhum laço de paginação sem limite máximo de páginas.
- **Default só preenche campo ausente de resposta válida.** Falha de leitura nunca vira resultado permissivo: "não consegui ler" e "não há restrição" são afirmações diferentes, e confundi-las libera publicações que o Reddit vai recusar. Erro de leitura sempre lança.
- **Reserva de orçamento é atômica.** A verificação e o incremento acontecem numa única função SQL com `SELECT ... FOR UPDATE`; nenhuma checagem-depois-escrita em duas etapas.
- **Teste que toca o banco vive em `tests/db/`** — o CI roda `--exclude "tests/db/**"`.
- **Portão de task:** `npm run verify` verde. O hook de pre-commit já bloqueia o commit se falhar.

## Pré-requisito

Nenhum. Este plano inteiro é implementável e testável **sem** credenciais reais do Reddit. A verificação end-to-end contra a API real fica registrada como pendência, junto com a do Plano 2.

---

### Task 1: Schema de comunidades

**Files:**
- Create: `supabase/migrations/<timestamp>_subreddits.sql`
- Test: `tests/db/subreddits.test.ts`

**Interfaces:**
- Consumes: `reddit_accounts` (Plano 2)
- Produces: tabela `public.subreddits`

**Decisão de modelagem:** comunidades removidas do Reddit — ou que a conta deixou de moderar — são marcadas com `status = 'removed'`, nunca apagadas. Publicações agendadas apontam para elas, e apagar a linha quebraria o histórico. A UI esconde as removidas; o histórico continua legível.

- [ ] **Step 1: Criar o arquivo de migration pelo CLI**

```powershell
npx supabase migration new subreddits
```

- [ ] **Step 2: Escrever os testes de integração falhando**

```ts
// tests/db/subreddits.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string

async function criarConta(ownerId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_sub_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function criarSubreddit(
  ownerId: string,
  contaId: string,
  nome: string,
) {
  const { data, error } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_${nome}`,
      name: nome,
      display_name: `Comunidade ${nome}`,
      url: `/r/${nome}/`,
      submission_type: 'any',
      link_flair_enabled: true,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`sr-a-${stamp}@teste.local`)
  userB = await createTestUser(`sr-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaB = await criarConta(userB.id, `b${stamp}`)
  subA = await criarSubreddit(userA.id, contaA, `comunidade_a_${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('subreddits', () => {
  it('o usuário lê apenas as próprias comunidades', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('subreddits')
      .select('id')
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(subA)
  })

  it('o usuário B não enxerga as comunidades de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('subreddits')
      .select('id')
      .eq('id', subA)
    expect(data).toHaveLength(0)
  })

  it('o usuário não consegue inserir comunidades', async () => {
    // Comunidades vêm exclusivamente da sincronização com a API.
    const { error } = await userClient(userA.accessToken)
      .from('subreddits')
      .insert({
        owner_id: userA.id,
        reddit_account_id: contaA,
        subreddit_fullname: 't5_forjada',
        name: 'forjada',
        display_name: 'Forjada',
        url: '/r/forjada/',
      })
    expect(error).not.toBeNull()
  })

  it('o usuário não consegue alterar nem apagar comunidades', async () => {
    const update = await userClient(userA.accessToken)
      .from('subreddits')
      .update({ name: 'renomeada' })
      .eq('id', subA)
    expect(update.error).not.toBeNull()

    const del = await userClient(userA.accessToken)
      .from('subreddits')
      .delete()
      .eq('id', subA)
    expect(del.error).not.toBeNull()

    const check = await adminClient()
      .from('subreddits')
      .select('name')
      .eq('id', subA)
      .single()
    expect(check.data!.name).not.toBe('renomeada')
  })

  it('impede a mesma comunidade duas vezes para a mesma conta', async () => {
    const nome = `dup_${Date.now()}`
    await criarSubreddit(userA.id, contaA, nome)
    await expect(criarSubreddit(userA.id, contaA, nome)).rejects.toBeTruthy()
  })

  it('permite a mesma comunidade em contas diferentes', async () => {
    // Duas contas do mesmo usuário podem moderar a mesma comunidade.
    const outraConta = await criarConta(userA.id, `outra${Date.now()}`)
    const nome = `compartilhada_${Date.now()}`
    await expect(criarSubreddit(userA.id, contaA, nome)).resolves.toBeTruthy()
    await expect(
      criarSubreddit(userA.id, outraConta, nome),
    ).resolves.toBeTruthy()
  })

  it('rejeita comunidade cujo owner_id diverge do dono da conta', async () => {
    const { error } = await adminClient().from('subreddits').insert({
      owner_id: userA.id, // owner errado de propósito
      reddit_account_id: contaB,
      subreddit_fullname: 't5_invalida',
      name: 'invalida',
      display_name: 'Inválida',
      url: '/r/invalida/',
    })
    expect(error).not.toBeNull()
  })

  it('rejeita submission_type fora da lista da API', async () => {
    const { error } = await adminClient()
      .from('subreddits')
      .update({ submission_type: 'inventado' })
      .eq('id', subA)
    expect(error).not.toBeNull()
  })

  it('rejeita status fora da lista permitida', async () => {
    const { error } = await adminClient()
      .from('subreddits')
      .update({ status: 'inventado' })
      .eq('id', subA)
    expect(error).not.toBeNull()
  })

  it('apagar a conta apaga as comunidades em cascata', async () => {
    const conta = await criarConta(userA.id, `casc${Date.now()}`)
    const sub = await criarSubreddit(userA.id, conta, `casc_${Date.now()}`)
    await adminClient().from('reddit_accounts').delete().eq('id', conta)

    const { data } = await adminClient()
      .from('subreddits')
      .select('id')
      .eq('id', sub)
    expect(data).toHaveLength(0)
  })

  it('authenticated tem apenas SELECT sobre subreddits', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_name = 'subreddits'
         order by privilege_type`,
      ),
    )
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/db/subreddits.test.ts`
Expected: FAIL — a relação `subreddits` não existe.

- [ ] **Step 4: Escrever a migration**

```sql
-- Comunidades moderadas por cada conta Reddit.
--
-- Estes dados são um espelho da API, não entrada do usuário: nascem e morrem
-- pela sincronização. Por isso `authenticated` recebe apenas SELECT.
create table public.subreddits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reddit_account_id uuid not null,

  -- Identidade no Reddit
  subreddit_fullname text not null,          -- t5_xxxxx
  name text not null,                        -- display_name, ex: "minhacomunidade"
  display_name text not null,                -- title da comunidade
  url text not null,                         -- /r/minhacomunidade/

  -- Campos que o formulário de publicação (Plano 4) usa para validar
  over_18 boolean not null default false,
  submission_type text
    check (submission_type in ('any', 'link', 'self')),
  link_flair_enabled boolean not null default false,
  can_assign_link_flair boolean not null default false,
  subreddit_type text,

  -- Comunidade que sumiu da listagem é marcada, nunca apagada: publicações
  -- agendadas apontam para ela e o histórico precisa continuar legível.
  status text not null default 'active'
    check (status in ('active', 'removed')),
  last_synced_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (reddit_account_id, subreddit_fullname),
  -- Alvos das FKs compostas do Plano 4 (scheduled_posts).
  unique (id, owner_id),
  unique (id, reddit_account_id),

  -- Garante no banco que a comunidade pertence ao mesmo dono da conta.
  foreign key (reddit_account_id, owner_id)
    references public.reddit_accounts (id, owner_id) on delete cascade
);

create index subreddits_owner_idx on public.subreddits (owner_id);
create index subreddits_account_idx
  on public.subreddits (reddit_account_id, status);

alter table public.subreddits enable row level security;

-- Apenas leitura: a escrita acontece pelo service_role, na sincronização.
grant select on public.subreddits to authenticated;
grant all on public.subreddits to service_role;

create policy "subreddits_select_own"
  on public.subreddits for select
  to authenticated
  using ( (select auth.uid()) = owner_id );

create trigger subreddits_set_updated_at
  before update on public.subreddits
  for each row execute function public.set_updated_at();
```

- [ ] **Step 5: Aplicar e rodar os testes**

```powershell
npx supabase db reset
npx vitest run tests/db/subreddits.test.ts
```

Expected: PASS. Se o `db reset` falhar com erro de container, repita — é transiente.

- [ ] **Step 6: Rodar os advisors**

Run: `npx supabase db advisors --local --type security`
Expected: `No issues found`

- [ ] **Step 7: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: schema de comunidades moderadas"
```

---

### Task 2: Orçamento global de rate limit

**Files:**
- Create: `supabase/migrations/<timestamp>_reddit_api_budget.sql`
- Create: `src/lib/reddit/budget.ts`
- Modify: `src/lib/reddit/client.ts` (callbacks `onBeforeRequest` e `onAfterRequest`)
- Modify: `src/lib/reddit/reddit-client-factory.ts` (injeta o gravador)
- Test: `tests/db/budget.test.ts`
- Test: `tests/reddit/client-budget.test.ts`

**Interfaces:**
- Consumes: `RateLimitSnapshot` (Plano 2)
- Produces:
  - `reserveBudget(): Promise<void>` — reserva capacidade **atomicamente**; lança `RedditError` com `code: 'BUDGET_EXHAUSTED'` quando negada
  - `reconcileBudget(snapshot: RateLimitSnapshot | null): Promise<void>` — devolve a reserva e sincroniza com os headers; `null` apenas libera
  - `getBudget(): Promise<Budget | null>`
  - `BUDGET_THRESHOLD` — folga mantida antes do limite real

**Por que agora, e não no Plano 5:** a sincronização de comunidades pagina `/subreddits/mine/moderator` e pode gastar várias requisições numa única ação do usuário, por conta. É a primeira funcionalidade capaz de esgotar a quota, então o orçamento precisa existir aqui. O que fica para o Plano 5 é a **espera** coordenada: aqui, orçamento esgotado significa recusar a ação com mensagem clara, sem dormir segurando um request HTTP.

### O modelo de reserva

Banco e chamada externa não formam uma transação — isso é da natureza do
problema. Mas a **reserva interna** precisa ser livre de corrida: duas
requisições concorrentes não podem reservar a mesma capacidade.

O ciclo tem três estados e uma coluna dedicada, `reserved`, que conta as
requisições em voo desde o último snapshot:

1. **Reservar**, antes da chamada: uma função SQL com `SELECT ... FOR UPDATE`
   serializa as chamadas concorrentes, verifica `remaining - reserved - 1`
   contra o limiar e incrementa `reserved`. Duas requisições simultâneas são
   necessariamente ordenadas pelo lock da linha, e a segunda enxerga a reserva
   da primeira.
2. **Reconciliar**, depois da resposta: grava `used`, `remaining` e `reset_at`
   vindos dos headers — que são a autoridade — e decrementa `reserved`.
3. **Liberar**, quando a requisição falha sem resposta: apenas decrementa
   `reserved`, sem tocar nos números do Reddit.

`reserved` é zerado quando a janela expira (`reset_at <= now()`), porque
reservas de uma janela encerrada não significam mais nada.

Quando `remaining` é desconhecido (nenhuma resposta ainda), a reserva é
permitida: o Reddit responde 429 no pior caso, e 429 é `retryable`.

- [ ] **Step 1: Criar a migration**

```powershell
npx supabase migration new reddit_api_budget
```

- [ ] **Step 2: Escrever os testes de banco falhando**

```ts
// tests/db/budget.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { adminClient } from './helpers'

beforeEach(async () => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake-budget'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  await adminClient().from('reddit_api_budget').delete().neq('client_id_hash', '')
})

async function semearOrcamento(remaining: number, resetSeconds = 300) {
  const { reserveBudget, reconcileBudget } = await import('@/lib/reddit/budget')
  // Uma reserva seguida de reconciliação deixa reserved = 0 e os números do
  // Reddit gravados, que é o estado normal entre requisições.
  await reserveBudget()
  await reconcileBudget({ used: 100 - remaining, remaining, resetSeconds })
}

describe('reconciliação do orçamento', () => {
  it('grava o snapshot vindo dos headers', async () => {
    const { getBudget } = await import('@/lib/reddit/budget')
    await semearOrcamento(90)

    const budget = await getBudget()
    expect(budget!.remaining).toBe(90)
    expect(budget!.used).toBe(10)
    expect(budget!.resetAt!.getTime()).toBeGreaterThan(Date.now())
    expect(budget!.reserved).toBe(0)
  })

  it('não guarda o client_id em claro, apenas o hash', async () => {
    await semearOrcamento(99)

    const { data } = await adminClient()
      .from('reddit_api_budget')
      .select('client_id_hash')
      .single()
    expect(data!.client_id_hash).not.toContain('cid-fake-budget')
    expect(data!.client_id_hash).toHaveLength(64)
  })

  it('snapshot nulo libera a reserva sem apagar os números conhecidos', async () => {
    const { reserveBudget, reconcileBudget, getBudget } = await import(
      '@/lib/reddit/budget'
    )
    await semearOrcamento(90)

    await reserveBudget()
    expect((await getBudget())!.reserved).toBe(1)

    await reconcileBudget(null)
    const budget = await getBudget()
    expect(budget!.remaining).toBe(90)
    expect(budget!.reserved).toBe(0)
  })

  it('pausa quando o restante fica abaixo do limiar', async () => {
    const { getBudget, BUDGET_THRESHOLD } = await import('@/lib/reddit/budget')
    await semearOrcamento(BUDGET_THRESHOLD - 1, 120)

    const budget = await getBudget()
    expect(budget!.pausedUntil).not.toBeNull()
    expect(budget!.pausedUntil!.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('reserva atômica', () => {
  it('sem orçamento conhecido, a reserva é permitida', async () => {
    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).resolves.toBeUndefined()
  })

  it('cada reserva incrementa o contador de requisições em voo', async () => {
    const { reserveBudget, getBudget } = await import('@/lib/reddit/budget')
    await semearOrcamento(90)

    await reserveBudget()
    await reserveBudget()
    expect((await getBudget())!.reserved).toBe(2)
  })

  it('recusa enquanto a pausa vale', async () => {
    const { reserveBudget, BUDGET_THRESHOLD } = await import(
      '@/lib/reddit/budget'
    )
    await semearOrcamento(BUDGET_THRESHOLD - 1)

    await expect(reserveBudget()).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      disposition: 'retryable',
    })
  })

  it('volta a permitir quando a janela expira', async () => {
    const { reserveBudget, getBudget } = await import('@/lib/reddit/budget')
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('cid-fake-budget').digest('hex')

    await adminClient().from('reddit_api_budget').upsert({
      client_id_hash: hash,
      used: 100,
      remaining: 0,
      reserved: 5,
      reset_at: new Date(Date.now() - 1000).toISOString(),
      paused_until: new Date(Date.now() - 1000).toISOString(),
    })

    await expect(reserveBudget()).resolves.toBeUndefined()

    // A janela encerrada zera as reservas em voo antes de contar a nova.
    const budget = await getBudget()
    expect(budget!.reserved).toBe(1)
  })

  it('CORRIDA: reservas concorrentes não excedem a capacidade', async () => {
    // Este é o teste que justifica a função SQL. Com remaining = threshold + 3,
    // cabem exatamente 3 reservas; as demais precisam ser recusadas mesmo
    // disparadas todas ao mesmo tempo.
    const { reserveBudget, getBudget, BUDGET_THRESHOLD } = await import(
      '@/lib/reddit/budget'
    )
    const capacidade = 3
    await semearOrcamento(BUDGET_THRESHOLD + capacidade)

    const tentativas = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveBudget()),
    )

    const aceitas = tentativas.filter((r) => r.status === 'fulfilled').length
    const recusadas = tentativas.filter((r) => r.status === 'rejected').length

    expect(aceitas).toBe(capacidade)
    expect(recusadas).toBe(10 - capacidade)
    expect((await getBudget())!.reserved).toBe(capacidade)
  })

  it('CORRIDA: o contador em voo nunca fica negativo', async () => {
    const { reconcileBudget, getBudget } = await import('@/lib/reddit/budget')
    await semearOrcamento(90)

    // Mais reconciliações que reservas: o contador satura em zero.
    await Promise.all([
      reconcileBudget(null),
      reconcileBudget(null),
      reconcileBudget(null),
    ])
    expect((await getBudget())!.reserved).toBe(0)
  })

  it('a mensagem de orçamento esgotado é legível e sem jargão', async () => {
    const { reserveBudget, BUDGET_THRESHOLD } = await import(
      '@/lib/reddit/budget'
    )
    await semearOrcamento(BUDGET_THRESHOLD - 1)

    try {
      await reserveBudget()
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/limite|aguard/i)
      expect(msg).not.toMatch(/undefined|null|hash/)
    }
  })

  it('as funções de orçamento não são chamáveis por anon nem authenticated', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, r.rolname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral (values ('anon'), ('authenticated')) as r(rolname)
         where n.nspname = 'public'
           and p.proname in ('reserve_api_budget', 'reconcile_api_budget')
           and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('o cliente não alcança a tabela pelo Data API', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select privilege_type from information_schema.role_table_grants
         where grantee in ('anon','authenticated')
           and table_name = 'reddit_api_budget'`,
      ),
    )
    expect(rows).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Escrever o teste do cliente falhando**

```ts
// tests/reddit/client-budget.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'

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

const me = (p: string) => p.startsWith('/api/v1/me')
const pool = () => agent.get('https://oauth.reddit.com')

describe('client e orçamento', () => {
  it('reserva antes de emitir a requisição', async () => {
    const ordem: string[] = []
    const onBeforeRequest = vi.fn(async () => {
      ordem.push('reserva')
    })

    pool()
      .intercept({ path: me, method: 'GET' })
      .reply(200, () => {
        ordem.push('requisicao')
        return { id: 't2_1' }
      })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest,
    })
    await client.request({ path: '/api/v1/me' })

    expect(ordem).toEqual(['reserva', 'requisicao'])
  })

  it('reserva negada impede a requisição e propaga o erro', async () => {
    const onBeforeRequest = vi.fn().mockRejectedValue(
      Object.assign(new Error('sem orçamento'), { code: 'BUDGET_EXHAUSTED' }),
    )

    // Nenhum intercept: se a requisição saísse, o teste falharia.
    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest,
    })

    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    })
  })

  it('reconcilia com o snapshot da resposta', async () => {
    const onAfterRequest = vi.fn()
    pool()
      .intercept({ path: me, method: 'GET' })
      .reply(200, { id: 't2_1' }, {
        headers: {
          'x-ratelimit-used': '5',
          'x-ratelimit-remaining': '95',
          'x-ratelimit-reset': '200',
        },
      })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await client.request({ path: '/api/v1/me' })

    expect(onAfterRequest).toHaveBeenCalledWith({
      used: 5,
      remaining: 95,
      resetSeconds: 200,
    })
  })

  it('também reconcilia quando a resposta é erro', async () => {
    const onAfterRequest = vi.fn()
    pool()
      .intercept({ path: me, method: 'GET' })
      .reply(429, {}, {
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '30' },
      })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toBeTruthy()
    expect(onAfterRequest).toHaveBeenCalled()
  })

  it('libera a reserva com null quando não há resposta', async () => {
    const onAfterRequest = vi.fn()
    pool()
      .intercept({ path: me, method: 'GET' })
      .replyWithError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toBeTruthy()

    // null significa "sem informação": libera a reserva sem mexer nos números.
    expect(onAfterRequest).toHaveBeenCalledWith(null)
  })

  it('toda reserva aceita tem exatamente uma devolução', async () => {
    const eventos: string[] = []
    const onBeforeRequest = vi.fn(async () => {
      eventos.push('reserva')
    })
    const onAfterRequest = vi.fn(async () => {
      eventos.push('devolucao')
    })

    pool().intercept({ path: me, method: 'GET' }).reply(200, { id: 't2_1' })
    pool().intercept({ path: me, method: 'GET' }).reply(403, {})
    pool()
      .intercept({ path: me, method: 'GET' })
      .replyWithError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest,
      onAfterRequest,
    })

    await client.request({ path: '/api/v1/me' }).catch(() => {})
    await client.request({ path: '/api/v1/me' }).catch(() => {})
    await client.request({ path: '/api/v1/me' }).catch(() => {})

    expect(eventos.filter((e) => e === 'reserva')).toHaveLength(3)
    expect(eventos.filter((e) => e === 'devolucao')).toHaveLength(3)
  })

  it('falha da reconciliação não derruba a requisição', async () => {
    // Reconciliar é telemetria: não pode custar a operação do usuário.
    const onAfterRequest = vi.fn().mockRejectedValue(new Error('banco fora'))
    pool().intercept({ path: me, method: 'GET' }).reply(200, { id: 't2_1' })

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onAfterRequest,
    })
    await expect(client.request({ path: '/api/v1/me' })).resolves.toBeTruthy()
  })

  it('sem callbacks, o cliente funciona normalmente', async () => {
    pool().intercept({ path: me, method: 'GET' }).reply(200, { id: 't2_1' })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(client.request({ path: '/api/v1/me' })).resolves.toBeTruthy()
  })
})
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `npx vitest run tests/db/budget.test.ts tests/reddit/client-budget.test.ts`
Expected: FAIL — módulo e relação inexistentes.

- [ ] **Step 5: Escrever a migration**

```sql
-- Orçamento de requisições da aplicação junto ao Reddit.
--
-- O limite do Reddit é por client_id, não por conta conectada nem por usuário
-- do painel. Uma linha por client_id, compartilhada por todas as instâncias
-- (web e, a partir do Plano 5, worker).
create table public.reddit_api_budget (
  -- SHA-256 do client_id: a tabela é infraestrutura, não precisa do valor.
  client_id_hash text primary key,
  used integer,
  remaining integer,
  reset_at timestamptz,
  -- Requisições em voo desde o último snapshot. Sem esta coluna, duas
  -- chamadas concorrentes veriam o mesmo `remaining` e reservariam a mesma
  -- capacidade.
  reserved integer not null default 0 check (reserved >= 0),
  paused_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.reddit_api_budget enable row level security;

-- Infraestrutura global: não pertence a nenhum owner e não é exposta ao Data API.
revoke all on public.reddit_api_budget from anon, authenticated;
grant all on public.reddit_api_budget to service_role;

create trigger reddit_api_budget_set_updated_at
  before update on public.reddit_api_budget
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Reserva atômica de capacidade.
-- ---------------------------------------------------------------
-- O SELECT ... FOR UPDATE serializa chamadas concorrentes: a segunda espera
-- a primeira terminar e enxerga a reserva dela. É isto que impede duas
-- requisições de reservarem a mesma capacidade.
--
-- SECURITY INVOKER de propósito: a função é chamada pelo service_role, que já
-- tem acesso à tabela, e não precisa de privilégio elevado.
create or replace function public.reserve_api_budget(
  p_client_id_hash text,
  p_threshold integer
)
returns table (allowed boolean, remaining integer, paused_until timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.reddit_api_budget;
begin
  insert into public.reddit_api_budget (client_id_hash)
  values (p_client_id_hash)
  on conflict (client_id_hash) do nothing;

  select * into v_row
  from public.reddit_api_budget
  where client_id_hash = p_client_id_hash
  for update;

  -- Janela encerrada: o orçamento anterior e as reservas em voo daquela
  -- janela não significam mais nada.
  if v_row.reset_at is not null and v_row.reset_at <= now() then
    update public.reddit_api_budget
    set used = null, remaining = null, reset_at = null,
        reserved = 0, paused_until = null
    where client_id_hash = p_client_id_hash
    returning * into v_row;
  end if;

  if v_row.paused_until is not null and v_row.paused_until > now() then
    return query select false, v_row.remaining, v_row.paused_until;
    return;
  end if;

  -- remaining nulo significa "ainda não sabemos": reservamos de forma
  -- otimista, e o 429 do Reddit (retryable) é a rede de proteção.
  if v_row.remaining is not null
     and (v_row.remaining - v_row.reserved - 1) < p_threshold then
    update public.reddit_api_budget
    set paused_until = coalesce(v_row.reset_at, now() + interval '60 seconds')
    where client_id_hash = p_client_id_hash
    returning * into v_row;
    return query select false, v_row.remaining, v_row.paused_until;
    return;
  end if;

  update public.reddit_api_budget
  set reserved = v_row.reserved + 1
  where client_id_hash = p_client_id_hash
  returning * into v_row;

  return query select true, v_row.remaining, v_row.paused_until;
end;
$$;

-- Devolve a reserva e sincroniza com os headers, que são a autoridade.
-- Parâmetros nulos significam "sem informação": apenas libera a reserva.
create or replace function public.reconcile_api_budget(
  p_client_id_hash text,
  p_used integer,
  p_remaining integer,
  p_reset_seconds integer,
  p_threshold integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reset_at timestamptz;
begin
  v_reset_at := case
    when p_reset_seconds is not null
      then now() + make_interval(secs => p_reset_seconds)
    else null
  end;

  update public.reddit_api_budget
  set
    used = coalesce(p_used, used),
    remaining = coalesce(p_remaining, remaining),
    reset_at = coalesce(v_reset_at, reset_at),
    reserved = greatest(reserved - 1, 0),
    paused_until = case
      when p_remaining is not null and p_remaining < p_threshold
        then coalesce(v_reset_at, now() + interval '60 seconds')
      else paused_until
    end
  where client_id_hash = p_client_id_hash;
end;
$$;

revoke execute on function public.reserve_api_budget(text, integer)
  from public, anon, authenticated;
revoke execute on function
  public.reconcile_api_budget(text, integer, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.reserve_api_budget(text, integer)
  to service_role;
grant execute on function
  public.reconcile_api_budget(text, integer, integer, integer, integer)
  to service_role;
```

- [ ] **Step 6: Implementar a lib de orçamento**

```ts
// src/lib/reddit/budget.ts
import 'server-only'
import { createHash } from 'node:crypto'
import { getRedditEnv } from '@/lib/config/env'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { RedditError } from './errors'
import type { RateLimitSnapshot } from './types'

/**
 * Abaixo deste número de requisições restantes, a aplicação se pausa até o
 * reset. A folga existe para não bater no 429 do Reddit, que é a fronteira
 * real — os headers são aproximados.
 */
export const BUDGET_THRESHOLD = 10

export type Budget = {
  used: number | null
  remaining: number | null
  /** Requisições em voo desde o último snapshot. */
  reserved: number
  resetAt: Date | null
  pausedUntil: Date | null
}

function clientHash(): string {
  return createHash('sha256')
    .update(getRedditEnv().REDDIT_CLIENT_ID)
    .digest('hex')
}

/**
 * Reserva capacidade antes de uma requisição ao Reddit.
 *
 * A atomicidade vive na função SQL: um SELECT ... FOR UPDATE serializa as
 * chamadas concorrentes, de modo que a segunda enxerga a reserva da primeira.
 * Sem isso, duas requisições simultâneas leriam o mesmo `remaining` e
 * reservariam a mesma capacidade.
 *
 * Toda reserva bem-sucedida PRECISA ser devolvida por reconcileBudget, mesmo
 * quando a requisição falha — senão o contador de requisições em voo só sobe.
 */
export async function reserveBudget(): Promise<void> {
  const admin = createAdminSupabase()
  const { data, error } = await admin.rpc('reserve_api_budget', {
    p_client_id_hash: clientHash(),
    p_threshold: BUDGET_THRESHOLD,
  })

  if (error) {
    // Falha ao falar com o orçamento não deve impedir o trabalho: o 429 do
    // Reddit continua sendo a rede de proteção.
    return
  }

  const resultado = Array.isArray(data) ? data[0] : data
  if (!resultado || resultado.allowed) return

  const pausadoAte = resultado.paused_until
    ? new Date(resultado.paused_until as string)
    : null
  const segundos = pausadoAte
    ? Math.max(1, Math.ceil((pausadoAte.getTime() - Date.now()) / 1000))
    : 60

  throw new RedditError({
    code: 'BUDGET_EXHAUSTED',
    disposition: 'retryable',
    retryAfterSeconds: segundos,
    userMessage: `O limite de requisições ao Reddit foi atingido. Aguarde cerca de ${segundos} segundos e tente novamente.`,
  })
}

/**
 * Devolve a reserva e sincroniza o orçamento com os headers da resposta.
 *
 * `null` significa que a requisição não produziu resposta legível: a reserva
 * é liberada sem alterar os números vindos do Reddit.
 */
export async function reconcileBudget(
  snapshot: RateLimitSnapshot | null,
): Promise<void> {
  const admin = createAdminSupabase()
  await admin.rpc('reconcile_api_budget', {
    p_client_id_hash: clientHash(),
    p_used: snapshot?.used ?? null,
    p_remaining: snapshot?.remaining ?? null,
    p_reset_seconds: snapshot?.resetSeconds ?? null,
    p_threshold: BUDGET_THRESHOLD,
  })
}

export async function getBudget(): Promise<Budget | null> {
  const admin = createAdminSupabase()
  const { data } = await admin
    .from('reddit_api_budget')
    .select('used, remaining, reset_at, reserved, paused_until')
    .eq('client_id_hash', clientHash())
    .maybeSingle()

  if (!data) return null

  return {
    used: data.used,
    remaining: data.remaining,
    reserved: data.reserved,
    resetAt: data.reset_at ? new Date(data.reset_at) : null,
    pausedUntil: data.paused_until ? new Date(data.paused_until) : null,
  }
}
```

- [ ] **Step 7: Ligar o cliente ao orçamento**

O cliente continua sem conhecer o banco: recebe dois callbacks e o factory
injeta as implementações.

Em `src/lib/reddit/client.ts`, no tipo de opções:

```ts
export function createRedditClient(opts: {
  accessToken: string
  dispatcher?: Dispatcher
  /**
   * Reserva capacidade antes da requisição. Pode lançar para recusar a
   * chamada — é assim que o orçamento esgotado impede o tráfego.
   */
  onBeforeRequest?: () => Promise<void>
  /**
   * Devolve a reserva. Recebe o snapshot dos headers, ou null quando não
   * houve resposta legível. Falhas aqui nunca derrubam a requisição.
   */
  onAfterRequest?: (
    snapshot: RateLimitSnapshot | null,
  ) => void | Promise<void>
}): RedditClient {
```

Dentro de `request`, **antes** de montar a requisição — o erro de orçamento
precisa subir para o chamador, então este `await` não é engolido:

```ts
      if (opts.onBeforeRequest) {
        await opts.onBeforeRequest()
      }
```

E a devolução da reserva, que precisa acontecer nos dois caminhos. No `catch`
da falha de rede, antes de classificar:

```ts
      } catch (err) {
        // Sem resposta: devolve a reserva sem tocar nos números do Reddit.
        if (opts.onAfterRequest) {
          void Promise.resolve(opts.onAfterRequest(null)).catch(() => {})
        }
        throw classifyNetwork(err, sideEffectAttempted)
      }
```

E logo após calcular `rateLimit`, antes de qualquer `throw` por status:

```ts
      const rateLimit = readRateLimit(rawHeaders)

      if (opts.onAfterRequest) {
        // Reconciliar é telemetria: não pode custar a operação do usuário.
        void Promise.resolve(opts.onAfterRequest(rateLimit)).catch(() => {})
      }
```

Em `src/lib/reddit/reddit-client-factory.ts`, na construção final:

```ts
  return createRedditClient({
    accessToken: secrets.accessToken,
    dispatcher,
    onBeforeRequest: reserveBudget,
    onAfterRequest: reconcileBudget,
  })
```

com o import correspondente:

```ts
import { reconcileBudget, reserveBudget } from './budget'
```

**Invariante a preservar:** toda reserva bem-sucedida precisa de exatamente uma
devolução. Se um caminho novo de saída for adicionado a `request` no futuro,
ele também precisa chamar `onAfterRequest` — senão o contador de requisições em
voo só cresce e o orçamento se pausa sozinho.

- [ ] **Step 8: Rodar e ver passar**

Run: `npx vitest run tests/db/budget.test.ts tests/reddit/client-budget.test.ts`
Expected: PASS

- [ ] **Step 9: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: orcamento global de rate limit por client_id"
```

---

### Task 3: Leitura das comunidades moderadas

**Files:**
- Create: `src/lib/reddit/communities.ts`
- Test: `tests/reddit/communities.test.ts`

**Interfaces:**
- Consumes: `RedditClient` (Plano 2)
- Produces:
  - `type ModeratedSubreddit` — `{ fullname, name, displayName, url, over18, submissionType, linkFlairEnabled, canAssignLinkFlair, subredditType }`
  - `listModeratedSubreddits(client: RedditClient): Promise<ModeratedSubreddit[]>`
  - `MAX_PAGES` — teto de paginação

O endpoint devolve um *Listing*: `{ kind: 'Listing', data: { after, before, children: [{ kind: 't5', data: {...} }] } }`. A paginação segue `after` até vir nulo, com teto de páginas — a spec registra que listagens do Reddit param em torno de mil itens, e um laço sem teto viraria loop infinito se a API repetisse o cursor.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/reddit/communities.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { listModeratedSubreddits, MAX_PAGES } from '@/lib/reddit/communities'

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
const moderator = (p: string) => p.startsWith('/subreddits/mine/moderator')

function t5(nome: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 't5',
    data: {
      id: nome,
      name: `t5_${nome}`,
      display_name: nome,
      display_name_prefixed: `r/${nome}`,
      title: `Comunidade ${nome}`,
      url: `/r/${nome}/`,
      over18: false,
      subscribers: 1234,
      user_is_moderator: true,
      submission_type: 'any',
      subreddit_type: 'public',
      link_flair_enabled: true,
      can_assign_link_flair: true,
      ...extra,
    },
  }
}

function listing(children: unknown[], after: string | null = null) {
  return { kind: 'Listing', data: { after, before: null, children } }
}

function client() {
  return createRedditClient({ accessToken: 'AT', dispatcher: agent })
}

describe('listModeratedSubreddits', () => {
  it('normaliza os campos de um t5', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('minhacomunidade')]))

    const subs = await listModeratedSubreddits(client())
    expect(subs).toHaveLength(1)
    expect(subs[0]).toEqual({
      fullname: 't5_minhacomunidade',
      name: 'minhacomunidade',
      displayName: 'Comunidade minhacomunidade',
      url: '/r/minhacomunidade/',
      over18: false,
      submissionType: 'any',
      linkFlairEnabled: true,
      canAssignLinkFlair: true,
      subredditType: 'public',
    })
  })

  it('segue a paginação pelo cursor after', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('primeira')], 't5_primeira'))
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('segunda')]))

    const subs = await listModeratedSubreddits(client())
    expect(subs.map((s) => s.name)).toEqual(['primeira', 'segunda'])
  })

  it('envia o cursor after na requisição seguinte', async () => {
    let segundaUrl = ''
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('primeira')], 'CURSOR-1'))
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, (opts) => {
        segundaUrl = String(opts.path)
        return listing([t5('segunda')])
      })

    await listModeratedSubreddits(client())
    expect(segundaUrl).toContain('after=CURSOR-1')
  })

  it('para no teto de páginas mesmo se a API repetir o cursor', async () => {
    // Cursor que nunca muda: sem teto, isto seria um laço infinito.
    for (let i = 0; i < MAX_PAGES + 2; i++) {
      pool()
        .intercept({ path: moderator, method: 'GET' })
        .reply(200, listing([t5(`repetida${i}`)], 'CURSOR-FIXO'))
    }

    const subs = await listModeratedSubreddits(client())
    expect(subs).toHaveLength(MAX_PAGES)
  })

  it('devolve lista vazia quando a conta não modera nada', async () => {
    pool().intercept({ path: moderator, method: 'GET' }).reply(200, listing([]))
    expect(await listModeratedSubreddits(client())).toEqual([])
  })

  it('ignora children que não são t5', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('valida'), { kind: 't2', data: { id: 'x' } }]))

    const subs = await listModeratedSubreddits(client())
    expect(subs.map((s) => s.name)).toEqual(['valida'])
  })

  it('aceita over_18 além de over18', async () => {
    // A API é inconsistente entre endpoints; aceitamos as duas formas.
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(
        200,
        listing([t5('nsfw', { over18: undefined, over_18: true })]),
      )

    const subs = await listModeratedSubreddits(client())
    expect(subs[0].over18).toBe(true)
  })

  it('trata submission_type ausente como any', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('sem_tipo', { submission_type: undefined })]))

    const subs = await listModeratedSubreddits(client())
    expect(subs[0].submissionType).toBe('any')
  })

  it('descarta entrada sem fullname, que não daria para identificar', async () => {
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, listing([t5('ok'), t5('quebrada', { name: undefined })]))

    const subs = await listModeratedSubreddits(client())
    expect(subs.map((s) => s.name)).toEqual(['ok'])
  })

  it('pede o limite máximo por página', async () => {
    let url = ''
    pool()
      .intercept({ path: moderator, method: 'GET' })
      .reply(200, (opts) => {
        url = String(opts.path)
        return listing([])
      })

    await listModeratedSubreddits(client())
    expect(url).toContain('limit=100')
  })

  it('propaga erro da API sem engolir', async () => {
    pool().intercept({ path: moderator, method: 'GET' }).reply(403, {})
    await expect(listModeratedSubreddits(client())).rejects.toMatchObject({
      code: 'NO_PERMISSION',
    })
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/reddit/communities.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// src/lib/reddit/communities.ts
import type { RedditClient } from './client'

/**
 * Teto de páginas da listagem.
 *
 * A cada página vêm até 100 comunidades, então 20 páginas cobrem 2000 — bem
 * acima do que qualquer conta modera na prática, e acima do limite de ~1000
 * itens que as listagens do Reddit costumam impor. O teto existe porque um
 * cursor repetido viraria laço infinito.
 */
export const MAX_PAGES = 20

export type ModeratedSubreddit = {
  fullname: string
  name: string
  displayName: string
  url: string
  over18: boolean
  submissionType: 'any' | 'link' | 'self'
  linkFlairEnabled: boolean
  canAssignLinkFlair: boolean
  subredditType: string | null
}

type Listing = {
  data?: {
    after?: string | null
    children?: { kind?: string; data?: Record<string, unknown> }[]
  }
}

function normalizar(
  raw: Record<string, unknown>,
): ModeratedSubreddit | null {
  const fullname = raw.name
  const name = raw.display_name
  if (typeof fullname !== 'string' || typeof name !== 'string') return null

  const tipo = raw.submission_type
  const submissionType =
    tipo === 'link' || tipo === 'self' || tipo === 'any' ? tipo : 'any'

  return {
    fullname,
    name,
    displayName: typeof raw.title === 'string' ? raw.title : name,
    url: typeof raw.url === 'string' ? raw.url : `/r/${name}/`,
    // A API alterna entre over18 e over_18 conforme o endpoint.
    over18: Boolean(raw.over18 ?? raw.over_18 ?? false),
    submissionType,
    linkFlairEnabled: Boolean(raw.link_flair_enabled ?? false),
    canAssignLinkFlair: Boolean(raw.can_assign_link_flair ?? false),
    subredditType:
      typeof raw.subreddit_type === 'string' ? raw.subreddit_type : null,
  }
}

export async function listModeratedSubreddits(
  client: RedditClient,
): Promise<ModeratedSubreddit[]> {
  const encontradas: ModeratedSubreddit[] = []
  const vistas = new Set<string>()
  let after: string | null = null

  for (let pagina = 0; pagina < MAX_PAGES; pagina++) {
    const query: Record<string, string> = { limit: '100' }
    if (after) query.after = after

    const { data } = await client.request<Listing>({
      path: '/subreddits/mine/moderator',
      query,
    })

    for (const child of data?.data?.children ?? []) {
      if (child.kind !== 't5' || !child.data) continue
      const sub = normalizar(child.data)
      // Cursor repetido pela API traria as mesmas comunidades de novo.
      if (sub && !vistas.has(sub.fullname)) {
        vistas.add(sub.fullname)
        encontradas.push(sub)
      }
    }

    after = data?.data?.after ?? null
    if (!after) break
  }

  return encontradas
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/reddit/communities.test.ts`
Expected: PASS

Atenção ao teste do teto: com cursor fixo, a deduplicação por `fullname` faz
cada página trazer uma comunidade distinta apenas porque o mock varia o nome.
Se o teste falhar por contagem, confira se o mock está gerando nomes
diferentes por página — é isso que separa "parou pelo teto" de "parou por
deduplicação".

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: leitura paginada das comunidades moderadas"
```

---

### Task 4: Sincronização das comunidades

**Files:**
- Create: `src/lib/reddit/sync-communities.ts`
- Test: `tests/db/sync-communities.test.ts`

**Interfaces:**
- Consumes: `VerifiedAccount`, `getRedditClient`, `listModeratedSubreddits` (a reserva de orçamento acontece dentro do cliente)
- Produces:
  - `type SyncResult` — `{ criadas: number; atualizadas: number; removidas: number; total: number }`
  - `syncCommunitiesFor(account: VerifiedAccount, opts?): Promise<SyncResult>`

**Regra central:** comunidades que sumiram da listagem viram `status = 'removed'`; as que voltarem, `active` de novo. Nada é apagado.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/db/sync-communities.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { randomBytes } from 'node:crypto'
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
  return syncCommunitiesFor(account, { dispatcher: agent, skipOwnershipCheck: true })
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

beforeEach(async () => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
  await adminClient().from('reddit_api_budget').delete().neq('client_id_hash', '')
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
      .reply(
        200,
        listing([
          t5('alpha', { submission_type: 'link' }),
          t5('beta'),
        ]),
      )

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
        data: { after: 'CURSOR-1', before: null, children: [t5('nova_pagina_1')] },
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/db/sync-communities.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// src/lib/reddit/sync-communities.ts
import 'server-only'
import type { Dispatcher } from 'undici'
import { createAdminSupabase } from '@/lib/supabase/admin'
import type { VerifiedAccount } from '@/lib/auth/ownership'
import { getRedditClient } from './reddit-client-factory'
import { listModeratedSubreddits } from './communities'

export type SyncResult = {
  criadas: number
  atualizadas: number
  removidas: number
  total: number
}

/**
 * Sincroniza as comunidades que a conta modera.
 *
 * A listagem completa vem primeiro e só então o banco é tocado: se a API
 * falhar no meio da paginação, nada é gravado e o estado anterior permanece
 * íntegro.
 */
export async function syncCommunitiesFor(
  account: VerifiedAccount,
  opts: { dispatcher?: Dispatcher; skipOwnershipCheck?: boolean } = {},
): Promise<SyncResult> {
  // A reserva por requisição acontece dentro do cliente; nada a fazer aqui
  // além de deixar o erro de orçamento subir para a server action.
  const client = await getRedditClient(account, opts)
  const remotas = await listModeratedSubreddits(client)

  const admin = createAdminSupabase()
  const agora = new Date().toISOString()

  const { data: existentes } = await admin
    .from('subreddits')
    .select('id, subreddit_fullname, status')
    .eq('reddit_account_id', account.id)

  const porFullname = new Map(
    (existentes ?? []).map((s) => [s.subreddit_fullname as string, s]),
  )

  let criadas = 0
  let atualizadas = 0

  for (const sub of remotas) {
    const linha = {
      owner_id: account.owner_id,
      reddit_account_id: account.id,
      subreddit_fullname: sub.fullname,
      name: sub.name,
      display_name: sub.displayName,
      url: sub.url,
      over_18: sub.over18,
      submission_type: sub.submissionType,
      link_flair_enabled: sub.linkFlairEnabled,
      can_assign_link_flair: sub.canAssignLinkFlair,
      subreddit_type: sub.subredditType,
      // Reativa quem tinha sumido e voltou.
      status: 'active',
      last_synced_at: agora,
    }

    if (porFullname.has(sub.fullname)) {
      atualizadas++
    } else {
      criadas++
    }

    await admin
      .from('subreddits')
      .upsert(linha, { onConflict: 'reddit_account_id,subreddit_fullname' })
  }

  // O que sumiu da listagem é marcado, nunca apagado: publicações agendadas
  // apontam para essas linhas e o histórico precisa continuar legível.
  const vistos = new Set(remotas.map((s) => s.fullname))
  const sumidas = (existentes ?? []).filter(
    (s) =>
      !vistos.has(s.subreddit_fullname as string) && s.status !== 'removed',
  )

  if (sumidas.length > 0) {
    await admin
      .from('subreddits')
      .update({ status: 'removed', last_synced_at: agora })
      .in(
        'id',
        sumidas.map((s) => s.id as string),
      )
  }

  return {
    criadas,
    atualizadas,
    removidas: sumidas.length,
    total: remotas.length,
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/db/sync-communities.test.ts`
Expected: PASS

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: sincronizacao de comunidades moderadas"
```

---

### Task 5: Flairs de publicação

**Files:**
- Create: `src/lib/reddit/flairs.ts`
- Test: `tests/reddit/flairs.test.ts`

**Interfaces:**
- Consumes: `RedditClient`
- Produces:
  - `type LinkFlair` — `{ id, text, textEditable, modOnly, backgroundColor, textColor }`
  - `listLinkFlairs(client, subredditName): Promise<LinkFlair[]>`

**Decisão:** flairs **não** são persistidos. Mudam sem aviso e ficariam desatualizados no formulário. São lidos sob demanda ao escolher a comunidade.

**Falha de leitura nunca vira lista vazia.** Há uma diferença que importa:

| Situação | Significado | Resultado |
|---|---|---|
| `200` com `[]` | a comunidade não tem flair cadastrado | `[]` — resultado válido |
| `403`, `404` | não conseguimos saber quais flairs existem | **lança** `FLAIRS_UNAVAILABLE` |
| `5xx`, rede | falha transitória | **lança**, `retryable` |

Retornar `[]` num erro HTTP faria o formulário afirmar "esta comunidade não usa
flair" quando a verdade é "não foi possível verificar" — e o Plano 4 usaria
essa afirmação para liberar um agendamento que o Reddit vai recusar. Quem
chama decide como apresentar a indisponibilidade; a camada de API não mente
sobre o que sabe.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/reddit/flairs.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { listLinkFlairs } from '@/lib/reddit/flairs'

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
const flairPath = (p: string) =>
  p.startsWith('/r/minhacomunidade/api/link_flair_v2')

const client = () => createRedditClient({ accessToken: 'AT', dispatcher: agent })

const flair = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: `Flair ${id}`,
  type: 'text',
  text_editable: false,
  mod_only: false,
  background_color: '#ff4500',
  text_color: 'light',
  allowable_content: 'all',
  max_emojis: 10,
  css_class: '',
  ...extra,
})

describe('listLinkFlairs', () => {
  it('normaliza os flairs da comunidade', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, [flair('abc'), flair('def')])

    const flairs = await listLinkFlairs(client(), 'minhacomunidade')
    expect(flairs).toHaveLength(2)
    expect(flairs[0]).toEqual({
      id: 'abc',
      text: 'Flair abc',
      textEditable: false,
      modOnly: false,
      backgroundColor: '#ff4500',
      textColor: 'light',
    })
  })

  it('usa o endpoint v2, não o depreciado', async () => {
    let url = ''
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, (opts) => {
        url = String(opts.path)
        return []
      })

    await listLinkFlairs(client(), 'minhacomunidade')
    expect(url).toContain('link_flair_v2')
  })

  it('200 com array vazio é resultado válido: a comunidade não tem flair', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(200, [])
    expect(await listLinkFlairs(client(), 'minhacomunidade')).toEqual([])
  })

  it('403 lança, em vez de fingir que não há flair', async () => {
    // Devolver [] aqui faria o formulário afirmar algo que não sabe.
    pool().intercept({ path: flairPath, method: 'GET' }).reply(403, {})
    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'FLAIRS_UNAVAILABLE' })
  })

  it('404 lança', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(404, {})
    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'FLAIRS_UNAVAILABLE' })
  })

  it('a mensagem de indisponibilidade diz que não foi possível verificar', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(403, {})
    try {
      await listLinkFlairs(client(), 'minhacomunidade')
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/não foi possível|nao foi possivel/i)
      // Não pode afirmar ausência de flair.
      expect(msg).not.toMatch(/não (tem|possui|usa) flair/i)
    }
  })

  it('descarta flair sem id, que não daria para enviar', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, [flair('ok'), { text: 'sem id' }])

    const flairs = await listLinkFlairs(client(), 'minhacomunidade')
    expect(flairs.map((f) => f.id)).toEqual(['ok'])
  })

  it('marca flair exclusivo de moderador', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, [flair('mod', { mod_only: true })])

    const flairs = await listLinkFlairs(client(), 'minhacomunidade')
    expect(flairs[0].modOnly).toBe(true)
  })

  it('resposta 200 que não é array lança, por ser formato inesperado', async () => {
    pool()
      .intercept({ path: flairPath, method: 'GET' })
      .reply(200, { erro: 'formato inesperado' })

    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'FLAIRS_UNAVAILABLE' })
  })

  it('erro de servidor propaga como transitório', async () => {
    pool().intercept({ path: flairPath, method: 'GET' }).reply(503, {})
    await expect(
      listLinkFlairs(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ disposition: 'retryable' })
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/reddit/flairs.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// src/lib/reddit/flairs.ts
import type { RedditClient } from './client'
import { RedditError } from './errors'

export type LinkFlair = {
  id: string
  text: string
  textEditable: boolean
  modOnly: boolean
  backgroundColor: string | null
  textColor: string | null
}

function normalizar(raw: unknown): LinkFlair | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  if (typeof f.id !== 'string' || f.id === '') return null

  return {
    id: f.id,
    text: typeof f.text === 'string' ? f.text : '',
    textEditable: Boolean(f.text_editable ?? false),
    modOnly: Boolean(f.mod_only ?? false),
    backgroundColor:
      typeof f.background_color === 'string' ? f.background_color : null,
    textColor: typeof f.text_color === 'string' ? f.text_color : null,
  }
}

function indisponivel(): RedditError {
  return new RedditError({
    code: 'FLAIRS_UNAVAILABLE',
    disposition: 'terminal',
    userMessage:
      'Não foi possível consultar os flairs desta comunidade. Verifique se a conta ainda a modera e tente novamente.',
  })
}

/**
 * Lê os flairs de publicação de uma comunidade.
 *
 * Não persiste nada: flairs mudam sem aviso e um cache desatualizado faria o
 * formulário oferecer opções que o Reddit recusaria na submissão.
 *
 * Lista vazia só é devolvida quando o Reddit respondeu com sucesso e não havia
 * flair cadastrado. Qualquer falha de leitura vira erro — devolver [] faria o
 * formulário afirmar "esta comunidade não usa flair" quando a verdade é "não
 * foi possível verificar", e o agendamento seria liberado com base numa
 * afirmação falsa.
 */
export async function listLinkFlairs(
  client: RedditClient,
  subredditName: string,
): Promise<LinkFlair[]> {
  let data: unknown

  try {
    ;({ data } = await client.request<unknown>({
      path: `/r/${subredditName}/api/link_flair_v2`,
    }))
  } catch (e) {
    // Sem permissão ou comunidade inexistente: não sabemos quais flairs
    // existem. Erros transitórios sobem com a disposição original.
    if (
      e instanceof RedditError &&
      (e.code === 'NO_PERMISSION' || e.code === 'NOT_FOUND')
    ) {
      throw indisponivel()
    }
    throw e
  }

  if (!Array.isArray(data)) throw indisponivel()

  return data.map(normalizar).filter((f): f is LinkFlair => f !== null)
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/reddit/flairs.test.ts`
Expected: PASS

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: leitura de flairs de publicacao"
```

---

### Task 6: Requisitos de publicação

**Files:**
- Create: `src/lib/reddit/requirements.ts`
- Test: `tests/reddit/requirements.test.ts`

**Interfaces:**
- Consumes: `RedditClient`
- Produces:
  - `type PostRequirements` — normalizado, com os campos que o Plano 4 consome
  - `getPostRequirements(client, subredditName): Promise<PostRequirements>`
  - `FIELD_DEFAULTS` — valores para **campos ausentes de uma resposta válida**

**O escopo dos defaults.** Eles preenchem campo que a resposta não trouxe —
nunca substituem uma resposta que não veio. Se a chamada falhar, a função
lança `REQUIREMENTS_UNAVAILABLE`, porque "não consegui ler os requisitos" e
"esta comunidade não tem requisitos" são afirmações diferentes, e tratar a
primeira como a segunda libera um agendamento que o Reddit vai recusar.

| Situação | Resultado |
|---|---|
| `200` com campos parciais | campos ausentes recebem o default |
| `200` sem nenhum campo | todos os defaults — a comunidade não impõe restrição |
| `403`, `404` | **lança** `REQUIREMENTS_UNAVAILABLE` |
| `5xx`, rede | **lança**, `retryable` |

Campos lidos de `GET /api/v1/{subreddit}/post_requirements`:
`title_text_min_length`, `title_text_max_length`, `body_restriction_policy`
(`required` | `notAllowed` | `none`), `is_flair_required`, `domain_whitelist`,
`domain_blacklist`, `title_blacklisted_strings`, `body_blacklisted_strings`.

**Limite conhecido, que o Plano 4 vai documentar na UI:** estes requisitos não
cobrem regras de AutoModerator. Uma publicação pode passar por toda a
validação local e ainda ser recusada na submissão.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/reddit/requirements.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import {
  FIELD_DEFAULTS,
  getPostRequirements,
} from '@/lib/reddit/requirements'

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
const reqPath = (p: string) =>
  p.startsWith('/api/v1/minhacomunidade/post_requirements')

const client = () => createRedditClient({ accessToken: 'AT', dispatcher: agent })

describe('getPostRequirements', () => {
  it('normaliza a resposta completa', async () => {
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, {
        title_text_min_length: 5,
        title_text_max_length: 300,
        body_restriction_policy: 'required',
        is_flair_required: true,
        domain_whitelist: ['youtube.com'],
        domain_blacklist: ['spam.com'],
        title_blacklisted_strings: ['proibido'],
        body_blacklisted_strings: ['tambem proibido'],
      })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req).toEqual({
      titleMinLength: 5,
      titleMaxLength: 300,
      bodyRestrictionPolicy: 'required',
      isFlairRequired: true,
      domainWhitelist: ['youtube.com'],
      domainBlacklist: ['spam.com'],
      titleBlacklistedStrings: ['proibido'],
      bodyBlacklistedStrings: ['tambem proibido'],
    })
  })

  it('resposta 200 vazia significa comunidade sem restrições', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    expect(await getPostRequirements(client(), 'minhacomunidade')).toEqual(
      FIELD_DEFAULTS,
    )
  })

  it('preenche apenas os campos ausentes de uma resposta parcial', async () => {
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { is_flair_required: true })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.isFlairRequired).toBe(true)
    expect(req.bodyRestrictionPolicy).toBe(FIELD_DEFAULTS.bodyRestrictionPolicy)
    expect(req.domainWhitelist).toEqual([])
  })

  it('o default de campo não impõe restrição que a comunidade não pediu', () => {
    expect(FIELD_DEFAULTS.bodyRestrictionPolicy).toBe('none')
    expect(FIELD_DEFAULTS.isFlairRequired).toBe(false)
    expect(FIELD_DEFAULTS.domainWhitelist).toEqual([])
  })

  it('o título nunca passa do limite do Reddit', async () => {
    // 300 é o teto da API; uma comunidade não pode ampliá-lo.
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { title_text_max_length: 9999 })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.titleMaxLength).toBe(300)
  })

  it('body_restriction_policy desconhecida vira none', async () => {
    pool()
      .intercept({ path: reqPath, method: 'GET' })
      .reply(200, { body_restriction_policy: 'inventado' })

    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.bodyRestrictionPolicy).toBe('none')
  })

  it('campos de lista ausentes viram array vazio, nunca null', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, {})
    const req = await getPostRequirements(client(), 'minhacomunidade')
    expect(req.domainBlacklist).toEqual([])
    expect(req.titleBlacklistedStrings).toEqual([])
  })

  it('403 lança, em vez de virar requisitos permissivos', async () => {
    // Aplicar defaults aqui liberaria um agendamento sem saber as regras.
    pool().intercept({ path: reqPath, method: 'GET' }).reply(403, {})
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'REQUIREMENTS_UNAVAILABLE' })
  })

  it('404 lança', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(404, {})
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ code: 'REQUIREMENTS_UNAVAILABLE' })
  })

  it('resposta 200 que não é objeto lança', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(200, 'texto solto')
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toBeTruthy()
  })

  it('a mensagem diz que não foi possível verificar, sem afirmar ausência', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(403, {})
    try {
      await getPostRequirements(client(), 'minhacomunidade')
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/não foi possível|nao foi possivel/i)
      expect(msg).not.toMatch(/sem restri|não (tem|possui) requisito/i)
    }
  })

  it('erro transitório propaga com a disposição original', async () => {
    pool().intercept({ path: reqPath, method: 'GET' }).reply(503, {})
    await expect(
      getPostRequirements(client(), 'minhacomunidade'),
    ).rejects.toMatchObject({ disposition: 'retryable' })
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/reddit/requirements.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// src/lib/reddit/requirements.ts
import type { RedditClient } from './client'
import { RedditError } from './errors'

export type BodyRestrictionPolicy = 'required' | 'notAllowed' | 'none'

export type PostRequirements = {
  titleMinLength: number | null
  titleMaxLength: number
  bodyRestrictionPolicy: BodyRestrictionPolicy
  isFlairRequired: boolean
  domainWhitelist: string[]
  domainBlacklist: string[]
  titleBlacklistedStrings: string[]
  bodyBlacklistedStrings: string[]
}

/** Limite duro do Reddit para títulos. Comunidade nenhuma amplia isso. */
const TITLE_HARD_MAX = 300

/**
 * Valores para campos AUSENTES de uma resposta válida — não substituto para
 * uma resposta que não veio.
 *
 * Não inventam restrição: validar a mais recusaria publicações que o Reddit
 * aceitaria. Aplicá-los a uma falha de leitura teria o efeito oposto e pior:
 * liberaria publicações que o Reddit vai recusar.
 */
export const FIELD_DEFAULTS: PostRequirements = {
  titleMinLength: null,
  titleMaxLength: TITLE_HARD_MAX,
  bodyRestrictionPolicy: 'none',
  isFlairRequired: false,
  domainWhitelist: [],
  domainBlacklist: [],
  titleBlacklistedStrings: [],
  bodyBlacklistedStrings: [],
}

function lista(valor: unknown): string[] {
  return Array.isArray(valor)
    ? valor.filter((v): v is string => typeof v === 'string')
    : []
}

function politica(valor: unknown): BodyRestrictionPolicy {
  return valor === 'required' || valor === 'notAllowed' ? valor : 'none'
}

/**
 * Lê os requisitos de publicação de uma comunidade.
 *
 * Falha de leitura NUNCA vira requisitos permissivos: se não conseguimos ler
 * as regras, não temos como afirmar que a publicação as respeita. Quem chama
 * decide o que fazer com a indisponibilidade — recusar o agendamento ou pedir
 * confirmação explícita — mas essa decisão precisa ser consciente.
 *
 * Atenção, mesmo no caminho feliz: estes requisitos NÃO cobrem regras de
 * AutoModerator. Uma publicação pode passar por toda a validação local e ainda
 * ser recusada na submissão.
 */
export async function getPostRequirements(
  client: RedditClient,
  subredditName: string,
): Promise<PostRequirements> {
  let raw: Record<string, unknown>

  try {
    const { data } = await client.request<Record<string, unknown>>({
      path: `/api/v1/${subredditName}/post_requirements`,
    })

    if (data !== null && typeof data !== 'object') {
      throw new RedditError({
        code: 'REQUIREMENTS_UNAVAILABLE',
        disposition: 'terminal',
        userMessage:
          'Não foi possível verificar as regras de publicação desta comunidade. Tente novamente.',
      })
    }

    // A partir daqui a resposta é válida: campos ausentes recebem default.
    raw = data ?? {}
  } catch (e) {
    if (
      e instanceof RedditError &&
      (e.code === 'NO_PERMISSION' || e.code === 'NOT_FOUND')
    ) {
      throw new RedditError({
        code: 'REQUIREMENTS_UNAVAILABLE',
        disposition: 'terminal',
        userMessage:
          'Não foi possível verificar as regras de publicação desta comunidade. Confirme se a conta ainda a modera e tente novamente.',
      })
    }
    throw e
  }

  const maxBruto = raw.title_text_max_length
  const titleMaxLength =
    typeof maxBruto === 'number' && maxBruto > 0
      ? Math.min(maxBruto, TITLE_HARD_MAX)
      : TITLE_HARD_MAX

  const minBruto = raw.title_text_min_length

  return {
    titleMinLength:
      typeof minBruto === 'number' && minBruto > 0 ? minBruto : null,
    titleMaxLength,
    bodyRestrictionPolicy: politica(raw.body_restriction_policy),
    isFlairRequired: Boolean(raw.is_flair_required ?? false),
    domainWhitelist: lista(raw.domain_whitelist),
    domainBlacklist: lista(raw.domain_blacklist),
    titleBlacklistedStrings: lista(raw.title_blacklisted_strings),
    bodyBlacklistedStrings: lista(raw.body_blacklisted_strings),
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/reddit/requirements.test.ts`
Expected: PASS

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: leitura dos requisitos de publicacao"
```

---

### Task 7: Página Comunidades

**Files:**
- Create: `src/app/(dashboard)/dashboard/communities/page.tsx`
- Create: `src/app/(dashboard)/dashboard/communities/actions.ts`
- Create: `src/components/communities/community-list.tsx`
- Create: `src/components/communities/sync-button.tsx`
- Test: `tests/communities/actions-security.test.ts`

**Interfaces:**
- Consumes: `assertAccountAccess`, `syncCommunitiesFor`
- Produces: server action `syncCommunities(prev, formData)`

**Rota:** `/dashboard/communities`, coerente com `NAV_ITEMS`. Lembre da lição do Plano 2: `(dashboard)` é route group e não entra na URL — a pasta precisa ficar sob `(dashboard)/dashboard/`.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/communities/actions-security.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const actions = readFileSync(
  'src/app/(dashboard)/dashboard/communities/actions.ts',
  'utf8',
)
const page = readFileSync(
  'src/app/(dashboard)/dashboard/communities/page.tsx',
  'utf8',
)

describe('server action de sincronização', () => {
  it('verifica a posse da conta antes de sincronizar', () => {
    const bloco = actions.slice(actions.indexOf('export async function'))
    expect(bloco).toContain('assertAccountAccess')
    const posse = bloco.indexOf('assertAccountAccess')
    const sync = bloco.indexOf('syncCommunitiesFor')
    expect(posse).toBeLessThan(sync)
  })

  it('não usa o client administrativo diretamente', () => {
    const usaAdmin = actions
      .split('\n')
      .some((l) => l.includes('createAdminSupabase') && !l.trim().startsWith('//'))
    expect(usaAdmin).toBe(false)
  })

  it('traduz o erro de orçamento em mensagem para o usuário', () => {
    expect(actions).toContain('BUDGET_EXHAUSTED')
  })

  it('valida o accountId recebido do formulário', () => {
    expect(actions).toMatch(/z\.uuid\(\)|safeParse/)
  })
})

describe('página de comunidades', () => {
  it('lê comunidades pelo client do usuário, com RLS', () => {
    expect(page).toContain('createServerSupabase')
    expect(page).not.toContain('createAdminSupabase')
  })

  it('esconde as comunidades removidas por padrão', () => {
    expect(page).toContain("'active'")
  })

  it('não seleciona nenhuma coluna sensível', () => {
    for (const proibido of ['access_token', 'refresh_token', 'proxy_password']) {
      expect(page).not.toContain(proibido)
    }
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/communities`
Expected: FAIL — arquivos inexistentes.

- [ ] **Step 3: Implementar a server action**

```ts
// src/app/(dashboard)/dashboard/communities/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { assertAccountAccess, ForbiddenError } from '@/lib/auth/ownership'
import { syncCommunitiesFor } from '@/lib/reddit/sync-communities'
import { RedditError } from '@/lib/reddit/errors'

const schema = z.object({ accountId: z.uuid() })

export type SyncState = {
  error: string | null
  message: string | null
}

export async function syncCommunities(
  _prev: SyncState,
  formData: FormData,
): Promise<SyncState> {
  const parsed = schema.safeParse({ accountId: formData.get('accountId') })
  if (!parsed.success) {
    return { error: 'Conta inválida.', message: null }
  }

  try {
    const account = await assertAccountAccess(parsed.data.accountId)
    const r = await syncCommunitiesFor(account)

    revalidatePath('/dashboard/communities')
    return {
      error: null,
      message:
        `${r.total} comunidade(s) sincronizada(s): ` +
        `${r.criadas} nova(s), ${r.atualizadas} atualizada(s)` +
        (r.removidas > 0 ? `, ${r.removidas} sem acesso` : '') +
        '.',
    }
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return { error: 'Conta não encontrada.', message: null }
    }
    if (e instanceof RedditError) {
      // Inclui BUDGET_EXHAUSTED, NO_PERMISSION e conta desconectada — todas
      // já trazem mensagem pronta para o usuário.
      return { error: e.userMessage, message: null }
    }
    return {
      error: 'Não foi possível sincronizar as comunidades agora.',
      message: null,
    }
  }
}
```

- [ ] **Step 4: Implementar os componentes**

```tsx
// src/components/communities/sync-button.tsx
'use client'

import { useActionState } from 'react'
import {
  syncCommunities,
  type SyncState,
} from '@/app/(dashboard)/dashboard/communities/actions'

const initial: SyncState = { error: null, message: null }

export function SyncButton({
  accountId,
  username,
}: {
  accountId: string
  username: string
}) {
  const [state, action, pending] = useActionState(syncCommunities, initial)

  return (
    <div>
      <form action={action}>
        <input type="hidden" name="accountId" value={accountId} />
        <button
          disabled={pending}
          className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
        >
          {pending ? 'Sincronizando…' : `Sincronizar u/${username}`}
        </button>
      </form>

      {state.error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="mt-2 text-xs text-green-700 dark:text-green-400">
          {state.message}
        </p>
      )}
    </div>
  )
}
```

```tsx
// src/components/communities/community-list.tsx
export type CommunityRow = {
  id: string
  name: string
  display_name: string
  url: string
  over_18: boolean
  submission_type: string | null
  link_flair_enabled: boolean
  last_synced_at: string | null
}

const TIPO_LABEL: Record<string, string> = {
  any: 'link e texto',
  link: 'somente link',
  self: 'somente texto',
}

export function CommunityList({ communities }: { communities: CommunityRow[] }) {
  if (communities.length === 0) {
    return (
      <p className="mt-3 text-sm text-neutral-500">
        Nenhuma comunidade sincronizada para esta conta ainda.
      </p>
    )
  }

  return (
    <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
      {communities.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
              r/{c.name}
            </p>
            <p className="truncate text-xs text-neutral-500">
              {c.display_name}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {c.submission_type && (
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                {TIPO_LABEL[c.submission_type] ?? c.submission_type}
              </span>
            )}
            {c.link_flair_enabled && (
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                flair
              </span>
            )}
            {c.over_18 && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                +18
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 5: Implementar a página**

```tsx
// src/app/(dashboard)/dashboard/communities/page.tsx
import { createServerSupabase } from '@/lib/supabase/server'
import {
  CommunityList,
  type CommunityRow,
} from '@/components/communities/community-list'
import { SyncButton } from '@/components/communities/sync-button'

export default async function CommunitiesPage() {
  const supabase = await createServerSupabase()

  const { data: contas } = await supabase
    .from('reddit_accounts')
    .select('id, username, status')
    .order('username')

  // Removidas ficam fora da lista: o histórico continua no banco, mas não faz
  // sentido oferecê-las para novas publicações.
  const { data: comunidades } = await supabase
    .from('subreddits')
    .select(
      'id, name, display_name, url, over_18, submission_type, link_flair_enabled, last_synced_at, reddit_account_id',
    )
    .eq('status', 'active')
    .order('name')

  const porConta = new Map<string, CommunityRow[]>()
  for (const c of comunidades ?? []) {
    const chave = c.reddit_account_id as string
    porConta.set(chave, [...(porConta.get(chave) ?? []), c as CommunityRow])
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Comunidades
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Comunidades que cada conta modera, lidas da API oficial do Reddit.
      </p>

      {(contas ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Conecte uma conta Reddit para sincronizar comunidades.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {contas!.map((conta) => {
            const lista = porConta.get(conta.id) ?? []
            const ultima = lista.find((c) => c.last_synced_at)?.last_synced_at

            return (
              <section
                key={conta.id}
                className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium text-neutral-900 dark:text-neutral-50">
                      u/{conta.username}
                    </h2>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {ultima
                        ? `Sincronizada em ${new Date(ultima).toLocaleString('pt-BR')}`
                        : 'Nunca sincronizada'}
                      {' · '}
                      {lista.length} comunidade(s)
                    </p>
                  </div>

                  {conta.status === 'connected' ? (
                    <SyncButton
                      accountId={conta.id}
                      username={conta.username}
                    />
                  ) : (
                    <p className="text-xs text-red-600">
                      Reconecte a conta para sincronizar.
                    </p>
                  )}
                </div>

                <CommunityList communities={lista} />
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run tests/communities`
Expected: PASS

- [ ] **Step 7: Confirmar a rota gerada**

```powershell
npm run build
```

Expected: a lista de rotas mostra `/dashboard/communities`. Se aparecer
`/communities`, a pasta ficou no nível errado do route group — mova para
`src/app/(dashboard)/dashboard/communities/`.

O teste `tests/nav/routes.test.ts` (Plano 2) também precisa ser atualizado
para incluir `/dashboard/communities` na lista de rotas implementadas.

- [ ] **Step 8: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: pagina de comunidades com sincronizacao por conta"
```

---

### Task 8: Isolamento multiusuário e documentação

**Files:**
- Test: `tests/db/communities-isolation.test.ts`
- Modify: `tests/nav/routes.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: tudo das tasks anteriores
- Produces: nenhuma API nova

- [ ] **Step 1: Escrever os testes de isolamento**

```ts
// tests/db/communities-isolation.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { MockAgent } from 'undici'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { encryptSecret } from '@/lib/crypto/aes-gcm'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaB: string
let subB: string

const sessao = { id: '' }
const clientToken = { value: '' }

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: async () => ({ id: sessao.id, email: 'x@teste.local' }),
  UnauthenticatedError: class extends Error {},
}))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () =>
    createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${clientToken.value}` } },
      },
    ),
}))

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  const stamp = Date.now()
  userA = await createTestUser(`ci-a-${stamp}@teste.local`)
  userB = await createTestUser(`ci-b-${stamp}@teste.local`)

  const { data: conta } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userB.id,
      reddit_user_id: `t2_ci_${stamp}`,
      username: 'conta_do_b',
    })
    .select('id')
    .single()
  contaB = conta!.id as string

  await adminClient().from('reddit_account_secrets').insert({
    reddit_account_id: contaB,
    owner_id: userB.id,
    access_token_enc: encryptSecret(
      'AT',
      `reddit_account_secrets:access_token:${contaB}`,
    ),
    refresh_token_enc: encryptSecret(
      'RT',
      `reddit_account_secrets:refresh_token:${contaB}`,
    ),
    access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })

  const { data: sub } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: userB.id,
      reddit_account_id: contaB,
      subreddit_fullname: `t5_ci_${stamp}`,
      name: 'comunidade_do_b',
      display_name: 'Comunidade do B',
      url: '/r/comunidade_do_b/',
    })
    .select('id')
    .single()
  subB = sub!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('isolamento das comunidades entre usuários', () => {
  it('A não lê as comunidades de B pelo Data API', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('subreddits')
      .select('id')
      .eq('id', subB)
    expect(data).toHaveLength(0)
  })

  it('A não sincroniza usando a conta de B', async () => {
    sessao.id = userA.id
    clientToken.value = userA.accessToken

    const agent = new MockAgent()
    agent.disableNetConnect()
    // Nenhum intercept: se a checagem de posse falhasse e a sincronização
    // seguisse, a chamada de rede quebraria o teste de forma barulhenta.

    const { syncCommunitiesFor } = await import('@/lib/reddit/sync-communities')
    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )

    await expect(assertAccountAccess(contaB)).rejects.toBeInstanceOf(
      ForbiddenError,
    )

    // E a via direta também barra, porque a action sempre passa por assert.
    await expect(
      (async () => {
        const conta = await assertAccountAccess(contaB)
        return syncCommunitiesFor(conta, { dispatcher: agent })
      })(),
    ).rejects.toBeInstanceOf(ForbiddenError)

    await agent.close()
  })

  it('a sincronização de B não cria comunidades no nome de A', async () => {
    const { data } = await adminClient()
      .from('subreddits')
      .select('owner_id')
      .eq('reddit_account_id', contaB)
    expect(data!.every((s) => s.owner_id === userB.id)).toBe(true)
  })

  it('o orçamento de rate limit não vaza para o cliente', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_api_budget')
      .select('remaining')
    expect(data ?? []).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Atualizar o teste de rotas do Plano 2**

Em `tests/nav/routes.test.ts`, acrescente a rota nova à lista de implementadas:

```ts
    const implementadas = [
      '/dashboard',
      '/dashboard/accounts',
      '/dashboard/communities',
    ]
```

- [ ] **Step 3: Rodar e ver passar**

Run: `npx vitest run tests/db/communities-isolation.test.ts tests/nav/routes.test.ts`
Expected: PASS

- [ ] **Step 4: Atualizar o README**

Substitua o bloco "Estado atual" por:

```markdown
## Estado atual

**Planos 1, 2 e 3 concluídos:** autenticação do painel, banco com RLS,
criptografia, sanitização de logs, OAuth do Reddit, gestão de contas,
configuração de rede por conta, sincronização das comunidades moderadas,
leitura de flairs e de requisitos de publicação, e orçamento global de rate
limit. As demais funcionalidades chegam nos Planos 4 e 5:

| Plano | Escopo |
|---|---|
| 4 | Criar e agendar publicações, comentários programados |
| 5 | Worker de publicação, calendário, fila, histórico, revisão |
```

Acrescente à lista de verificações pendentes:

```markdown
- [ ] **Sincronização de comunidades contra a API real.** Depende das mesmas
      credenciais do item anterior. Roteiro: conectar uma conta, abrir
      **Comunidades**, clicar em **Sincronizar**, e conferir que as
      comunidades moderadas aparecem com o tipo de submissão correto.
```

E acrescente à seção "Decisões de segurança já implementadas":

```markdown
- Comunidades são um espelho da API, não entrada do usuário: `authenticated`
  tem apenas `SELECT` sobre `subreddits`. Comunidades que somem viram
  `removed`, nunca são apagadas, porque publicações agendadas apontam para elas.
- Os requisitos de publicação lidos da API **não** cobrem regras de
  AutoModerator. Uma publicação pode passar por toda a validação local e ainda
  ser recusada no momento da submissão — por isso o sistema trata a resposta
  do Reddit como autoridade final, nunca a validação local.
- O orçamento de requisições é global por `client_id`, não por conta nem por
  usuário do painel, porque é assim que o Reddit conta. A tabela que o guarda
  é inalcançável pelo Data API.
```

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "test: isolamento multiusuario das comunidades e docs"
```

---

## Critério de aceitação do Plano 3

- [ ] `npm run verify` verde
- [ ] `authenticated` tem **apenas** `SELECT` sobre `subreddits`; não insere, não altera, não apaga
- [ ] Usuário A não lê comunidades de B nem sincroniza usando conta de B
- [ ] `reddit_api_budget` inalcançável pelo Data API
- [ ] Comunidade que sumiu vira `removed`, nunca é apagada; e volta a `active` se reaparecer
- [ ] Falha da API no meio da sincronização não deixa o banco pela metade
- [ ] Paginação para no teto mesmo se a API repetir o cursor
- [ ] `200` com array vazio de flairs é resultado válido; `403`/`404` lançam `FLAIRS_UNAVAILABLE`
- [ ] Falha ao ler requisitos lança `REQUIREMENTS_UNAVAILABLE`, nunca vira requisitos permissivos
- [ ] Defaults preenchem apenas campos ausentes de resposta `200` válida
- [ ] Nenhuma mensagem de indisponibilidade afirma ausência de flair ou de restrição
- [ ] Título nunca aceita limite acima de 300 caracteres
- [ ] **Reservas concorrentes não excedem a capacidade** — provado por teste com 10 tentativas simultâneas e capacidade 3
- [ ] Contador de requisições em voo nunca fica negativo e zera na virada de janela
- [ ] Toda reserva aceita tem exatamente uma devolução, inclusive em erro HTTP e falha de rede
- [ ] As funções de orçamento não são executáveis por `anon` nem `authenticated`
- [ ] Orçamento esgotado recusa a ação com mensagem legível, sem segurar requisição HTTP
- [ ] `npm run build` mostra `/dashboard/communities` — não `/communities`
- [ ] `npx supabase db advisors --local` sem apontamentos
- [ ] Nenhum teste faz requisição real ao Reddit; a suíte passa sem `REDDIT_CLIENT_ID`

## Verificação pendente (depende da aprovação do Reddit)

O plano inteiro é implementável e testável sem credenciais. Fica em aberto,
junto com o e2e do Plano 2:

- sincronizar comunidades de uma conta real e conferir que os campos
  (`submission_type`, `link_flair_enabled`, `over_18`) batem com o que o Reddit
  mostra na interface;
- ler flairs de uma comunidade real e confirmar o formato do `link_flair_v2`;
- ler `post_requirements` de uma comunidade com flair obrigatório e confirmar
  `is_flair_required: true`.

Esses três pontos são os únicos em que o formato real da API pode divergir dos
mocks. Se divergirem, o ajuste é no normalizador — e os testes existentes
apontam exatamente onde.

## O que vem no Plano 4

Fase 4 da spec: formulário de nova publicação, `payload-builder` decidindo
entre `link` e `self` a partir dos requisitos lidos aqui, validação Zod,
agendamento e comentários programados.
