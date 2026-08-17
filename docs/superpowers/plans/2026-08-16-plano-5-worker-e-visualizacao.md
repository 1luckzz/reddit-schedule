# Reddit Post Scheduler — Plano 5: Worker de Publicação e Visualização

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar de fato no Reddit — com claim atômico, janela de incerteza tratada e retentativas por disposição — e dar visibilidade completa do que está agendado, do que falhou e do que precisa de decisão humana.

**Architecture:** Um processo Node standalone consome jobs do banco por claim atômico (`FOR UPDATE SKIP LOCKED`), marca `submit_attempted_at` antes de escrever a requisição, e trata resultado desconhecido como `needs_review` em vez de retentar. As páginas apenas leem — nenhuma delas publica nada.

**Spec:** `docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md` (revisão 2, aprovada)

**Fase da spec coberta:** 5 e 6.

## Dois blocos, um checkpoint no meio

| Bloco | Tasks | Entrega |
|---|---|---|
| **A — Worker** | 1 a 9 | publica de verdade; verificável por teste sem UI |
| **B — Visualização** | 10 a 15 | Revisão, Fila, Histórico, Calendário, Dashboard |

O bloco B depende de dados que só o A produz. Executar A inteiro antes de começar B evita construir telas sobre um comportamento ainda não provado.

## Global Constraints

As dos Planos 1 a 4 continuam valendo. Estas se somam:

- **Nenhuma chamada real ao Reddit enquanto a Data API não for aprovada.** `undici.MockAgent` em todo teste; a suíte passa sem `REDDIT_CLIENT_ID`.
- **`submit_attempted_at` é gravado e commitado ANTES de escrever a requisição de efeito.** É o que separa "nunca saiu" de "pode ter chegado".
- **Resultado desconhecido nunca é retentado.** Vai para `needs_review` e espera decisão humana.
- **`safeToRetryEffect` decide a limpeza de `submit_attempted_at`, nunca `disposition`.** São perguntas diferentes: `retryable` responde "vale a pena tentar de novo?", `safeToRetryEffect` responde "repetir a operação de efeito é seguro?". Só a segunda autoriza devolver o job à fila com o campo limpo. Um erro `unknown` tem `safeToRetryEffect: false` por definição, sem exceção.
- **O worker nunca dorme segurando um job.** Espera de orçamento acontece antes do claim; um job já reivindicado mantém o lock vivo por heartbeat.
- **O reaper não transforma estado ambíguo em nova submissão.** Só devolve à fila o que tem `submit_attempted_at` nulo.
- **A chave secreta é lida em exatamente três lugares.** `config/env.ts` (validação de subida), `supabase/admin.ts` (`server-only`, caminho do Next) e `worker/supabase.ts` (fora da árvore do Next). O módulo compartilhado é uma factory **pura** que recebe URL e chave por parâmetro. Nenhum módulo alcançável a partir de um arquivo `'use client'` lê ou contém a chave — há teste que percorre o grafo de imports.
- **Toda reserva de orçamento é devolvida**, inclusive em falha — invariante do Plano 3.
- **Logs passam por `sanitize()`** antes de qualquer escrita ou `console`.
- **As páginas do bloco B são somente leitura.** Nenhuma delas chama a API do Reddit nem muta estado, exceto as ações já existentes de reagendar/cancelar e a resolução manual da Revisão.
- **Portão de task:** `npm run verify` verde; o hook de pre-commit bloqueia o resto.

---

# Bloco A — Worker

### Task 1: Logs de execução e funções de claim

**Files:**
- Create: `supabase/migrations/<timestamp>_execution_logs.sql`
- Create: `supabase/migrations/<timestamp>_claim_functions.sql`
- Test: `tests/db/execution-logs.test.ts`
- Test: `tests/db/claim-functions.test.ts`

**Interfaces:**
- Produces: tabela `public.execution_logs`; funções `claim_due_posts`, `claim_due_comments`, `reap_stale_jobs`, `renew_job_lock`, `materialize_comment_schedule`

**A decisão central:** o claim é uma função SQL, não uma sequência de consultas da aplicação. `FOR UPDATE SKIP LOCKED` dentro de uma transação garante que duas instâncias do worker nunca processam o mesmo job **ao mesmo tempo** — que é a garantia real, e não exactly-once.

- [ ] **Step 1: Criar as migrations**

```powershell
npx supabase migration new execution_logs
npx supabase migration new claim_functions
```

- [ ] **Step 2: Escrever os testes de `execution_logs` falhando**

```ts
// tests/db/execution-logs.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`el-a-${stamp}@teste.local`)
  userB = await createTestUser(`el-b-${stamp}@teste.local`)

  await adminClient().from('execution_logs').insert({
    owner_id: userA.id,
    action: 'submit_post',
    outcome: 'success',
    http_status: 200,
    duration_ms: 350,
  })
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('execution_logs', () => {
  it('o usuário lê apenas os próprios registros', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('execution_logs')
      .select('id')
    expect((data ?? []).length).toBeGreaterThan(0)
  })

  it('o usuário B não enxerga registros de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('execution_logs')
      .select('id')
    expect(data).toHaveLength(0)
  })

  it('authenticated tem apenas SELECT', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_name = 'execution_logs'
         order by privilege_type`,
      ),
    )
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
  })

  it('o usuário não insere registros: quem escreve é o worker', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('execution_logs')
      .insert({ owner_id: userA.id, action: 'forjado', outcome: 'success' })
    expect(error).not.toBeNull()
  })

  it('recusa outcome fora da lista', async () => {
    const { error } = await adminClient().from('execution_logs').insert({
      owner_id: userA.id,
      action: 'submit_post',
      outcome: 'inventado',
    })
    expect(error).not.toBeNull()
  })

  it('apagar o usuário apaga os logs em cascata', async () => {
    const temp = await createTestUser(`el-t-${Date.now()}@teste.local`)
    await adminClient().from('execution_logs').insert({
      owner_id: temp.id,
      action: 'submit_post',
      outcome: 'failure',
    })
    await cleanupTestUsers([temp.id])

    const { data } = await adminClient()
      .from('execution_logs')
      .select('id')
      .eq('owner_id', temp.id)
    expect(data).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Escrever a migration de `execution_logs`**

```sql
create table public.execution_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reddit_account_id uuid references public.reddit_accounts (id) on delete set null,
  scheduled_post_id uuid references public.scheduled_posts (id) on delete cascade,
  scheduled_comment_id uuid
    references public.scheduled_comments (id) on delete cascade,

  action text not null,
  http_status integer,
  outcome text not null
    check (outcome in ('success', 'failure', 'retry', 'unknown')),
  error_code text,
  -- Já sanitizado pela aplicação antes de chegar aqui.
  error_message text,
  duration_ms integer,

  created_at timestamptz not null default now()
);

create index execution_logs_owner_idx
  on public.execution_logs (owner_id, created_at desc);
create index execution_logs_post_idx
  on public.execution_logs (scheduled_post_id);
-- Usado pela limpeza por retenção.
create index execution_logs_created_idx on public.execution_logs (created_at);

alter table public.execution_logs enable row level security;

-- Somente leitura: quem escreve é o worker, via service_role.
grant select on public.execution_logs to authenticated;
grant all on public.execution_logs to service_role;

create policy "execution_logs_select_own"
  on public.execution_logs for select
  to authenticated
  using ( (select auth.uid()) = owner_id );
```

- [ ] **Step 4: Escrever os testes de claim falhando**

```ts
// tests/db/claim-functions.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'

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
  await adminClient()
    .from('scheduled_posts')
    .delete()
    .eq('owner_id', userA.id)
  await adminClient()
    .from('reddit_accounts')
    .update({ last_submit_at: null, min_interval_seconds: 0 })
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
    await criarPost({ scheduled_at: new Date(Date.now() + 3600_000).toISOString() })
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

  it('não pega job que não está em scheduled', async () => {
    for (const status of ['draft', 'processing', 'published', 'failed', 'cancelled', 'needs_review']) {
      await adminClient().from('scheduled_posts').delete().eq('owner_id', userA.id)
      await criarPost({ status })
      const { data } = await claim('worker-1')
      expect(data).toHaveLength(0)
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
    await criarPost({ scheduled_at: new Date(Date.now() - 60_000).toISOString() })

    const { data } = await claim('worker-1', 1)
    expect(data![0].id).toBe(velho)
  })

  it('CORRIDA: dois workers nunca pegam o mesmo job', async () => {
    // A garantia central: at-most-one concurrent claim.
    const ids = []
    for (let i = 0; i < 6; i++) ids.push(await criarPost())

    const [a, b] = await Promise.all([claim('worker-1', 6), claim('worker-2', 6)])

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

    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'connected' })
      .eq('id', conta)
  })

  it('a função não é chamável por anon nem authenticated', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral (values ('anon'), ('authenticated')) as r(rolname)
         where n.nspname = 'public'
           and p.proname in ('claim_due_posts', 'claim_due_comments',
                             'reap_stale_jobs', 'renew_job_lock')
           and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })
})
```

- [ ] **Step 5: Escrever a migration das funções de claim**

```sql
-- ---------------------------------------------------------------
-- Claim atômico de publicações
-- ---------------------------------------------------------------
-- `for update skip locked` serializa: duas instâncias do worker nunca
-- processam o mesmo job ao mesmo tempo. Isso é at-most-one concurrent claim,
-- NÃO exactly-once — a janela entre enviar e gravar o resultado é tratada por
-- submit_attempted_at, não por locking.
create or replace function public.claim_due_posts(
  p_worker_id text,
  p_batch integer
)
returns setof public.scheduled_posts
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.scheduled_posts sp
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id
  from (
    select candidato.id
    from public.scheduled_posts candidato
    join public.reddit_accounts ra on ra.id = candidato.reddit_account_id
    where candidato.status = 'scheduled'
      and candidato.scheduled_at <= now()
      and (candidato.next_attempt_at is null
           or candidato.next_attempt_at <= now())
      -- Conta desconectada não publica: o job espera a reconexão.
      and ra.status = 'connected'
      -- Espaçamento mínimo entre publicações da mesma conta.
      and (ra.last_submit_at is null
           or ra.last_submit_at
              + make_interval(secs => ra.min_interval_seconds) <= now())
    order by candidato.scheduled_at
    for update of candidato skip locked
    limit p_batch
  ) due
  where sp.id = due.id
  returning sp.*;
end;
$$;

-- ---------------------------------------------------------------
-- Claim atômico de comentários
-- ---------------------------------------------------------------
-- Só é elegível o comentário cujo post pai já publicou e tem reddit_post_id.
create or replace function public.claim_due_comments(
  p_worker_id text,
  p_batch integer
)
returns setof public.scheduled_comments
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.scheduled_comments sc
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id
  from (
    select candidato.id
    from public.scheduled_comments candidato
    join public.scheduled_posts sp on sp.id = candidato.scheduled_post_id
    join public.reddit_accounts ra on ra.id = candidato.reddit_account_id
    where candidato.status = 'scheduled'
      and candidato.scheduled_at is not null
      and candidato.scheduled_at <= now()
      and (candidato.next_attempt_at is null
           or candidato.next_attempt_at <= now())
      -- O comentário só existe se o post existir no Reddit.
      and sp.status = 'published'
      and sp.reddit_fullname is not null
      and ra.status = 'connected'
    order by candidato.scheduled_at
    for update of candidato skip locked
    limit p_batch
  ) due
  where sc.id = due.id
  returning sc.*;
end;
$$;

-- ---------------------------------------------------------------
-- Materialização do horário dos comentários
-- ---------------------------------------------------------------
-- Nos modos immediate e delay o horário só existe depois que sabemos o
-- published_at real do post. No modo absolute o horário já foi definido na
-- criação e pode estar no passado — nesse caso o comentário fica elegível
-- imediatamente, que é o comportamento desejado.
create or replace function public.materialize_comment_schedule(
  p_post_id uuid,
  p_published_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.scheduled_comments
  set scheduled_at = case
        when mode = 'immediate' then p_published_at
        when mode = 'delay'
          then p_published_at + make_interval(mins => delay_minutes)
        else scheduled_at
      end
  where scheduled_post_id = p_post_id
    and status = 'scheduled'
    and mode in ('immediate', 'delay');
end;
$$;

-- ---------------------------------------------------------------
-- Reaper
-- ---------------------------------------------------------------
-- Job preso em processing significa que o worker morreu. O desfecho depende
-- de submit_attempted_at:
--   nulo     -> a requisição comprovadamente não saiu, volta para a fila;
--   presente -> pode ter chegado ao Reddit, vai para needs_review.
--
-- O reaper NUNCA transforma estado ambíguo em nova submissão.
create or replace function public.reap_stale_jobs(p_timeout_seconds integer)
returns table (kind text, job_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - make_interval(secs => p_timeout_seconds);
begin
  return query
  with devolvidos as (
    update public.scheduled_posts
    set status = 'scheduled', locked_at = null, locked_by = null
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is null
    returning id
  ),
  ambiguos as (
    update public.scheduled_posts
    set status = 'needs_review',
        locked_at = null,
        locked_by = null,
        review_reason = 'OUTCOME_UNKNOWN_WORKER_DIED'
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is not null
    returning id
  ),
  com_devolvidos as (
    update public.scheduled_comments
    set status = 'scheduled', locked_at = null, locked_by = null
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is null
    returning id
  ),
  com_ambiguos as (
    update public.scheduled_comments
    set status = 'needs_review',
        locked_at = null,
        locked_by = null,
        review_reason = 'OUTCOME_UNKNOWN_WORKER_DIED'
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is not null
    returning id
  )
  select 'post'::text, id, 'requeued'::text from devolvidos
  union all
  select 'post'::text, id, 'needs_review'::text from ambiguos
  union all
  select 'comment'::text, id, 'requeued'::text from com_devolvidos
  union all
  select 'comment'::text, id, 'needs_review'::text from com_ambiguos;
end;
$$;

-- ---------------------------------------------------------------
-- Renovação de lock (heartbeat)
-- ---------------------------------------------------------------
-- O worker às vezes precisa esperar mais que o timeout do reaper para
-- terminar um único job — refresh de token lento, proxy ruim, resposta
-- demorada. Sem heartbeat, o reaper recuperaria um job que ainda está vivo e
-- outro worker publicaria o mesmo conteúdo.
--
-- Duas defesas essenciais:
--   1. `locked_by = p_worker_id` — só o dono renova. Um worker não pode
--      prolongar o lock de outro.
--   2. Retorno booleano — falso significa "você perdeu o lock". O chamador
--      DEVE abortar; continuar seria processar um job que outra instância já
--      pode ter reivindicado.
create or replace function public.renew_job_lock(
  p_kind text,
  p_job_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean := false;
begin
  if p_kind = 'post' then
    update public.scheduled_posts
    set locked_at = now()
    where id = p_job_id
      and status = 'processing'
      and locked_by = p_worker_id;
    v_ok := found;
  elsif p_kind = 'comment' then
    update public.scheduled_comments
    set locked_at = now()
    where id = p_job_id
      and status = 'processing'
      and locked_by = p_worker_id;
    v_ok := found;
  else
    raise exception 'kind invalido: %', p_kind;
  end if;

  return v_ok;
end;
$$;

revoke execute on function public.claim_due_posts(text, integer)
  from public, anon, authenticated;
revoke execute on function public.claim_due_comments(text, integer)
  from public, anon, authenticated;
revoke execute on function public.reap_stale_jobs(integer)
  from public, anon, authenticated;
revoke execute on function public.renew_job_lock(text, uuid, text)
  from public, anon, authenticated;
revoke execute on function
  public.materialize_comment_schedule(uuid, timestamptz)
  from public, anon, authenticated;

grant execute on function public.claim_due_posts(text, integer) to service_role;
grant execute on function public.claim_due_comments(text, integer) to service_role;
grant execute on function public.reap_stale_jobs(integer) to service_role;
grant execute on function public.renew_job_lock(text, uuid, text) to service_role;
grant execute on function
  public.materialize_comment_schedule(uuid, timestamptz) to service_role;
```

**Nota sobre o trigger `protect_post_execution_columns`.** Ele existe desde o
Plano 4 e bloqueia mutação das colunas de execução fora do backend. `locked_at`
está entre elas, e `renew_job_lock` é `security definer` rodando como owner —
o mesmo caminho já usado por `claim_due_posts`. A Step 6 valida isso na
prática.

- [ ] **Step 6: Aplicar, rodar, verificar**

```powershell
npx supabase db reset
npx vitest run tests/db/execution-logs.test.ts tests/db/claim-functions.test.ts
npx supabase db advisors --local --type security
npm run verify
```

Atenção ao `for update of candidato`: sem o `of`, o Postgres tentaria travar
também as linhas de `reddit_accounts` do join, e o `skip locked` passaria a
pular contas em vez de jobs.

```bash
git add -A
git commit -m "feat: logs de execucao e funcoes de claim atomico"
```

---

### Task 2: Testes do reaper

**Files:**
- Test: `tests/db/reaper.test.ts`

Separado da Task 1 de propósito: o reaper é a regra mais delicada do sistema,
e merece um arquivo próprio em vez de virar apêndice do claim.

- [ ] **Step 1: Escrever os testes**

```ts
// tests/db/reaper.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'

let userA: { id: string; accessToken: string }
let conta: string
let sub: string

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
      scheduled_at: new Date(Date.now() - 600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
      status: 'processing',
      // Travado há muito tempo: o worker morreu.
      locked_at: new Date(Date.now() - 3600_000).toISOString(),
      locked_by: 'worker-morto',
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

const reap = (timeout = 600) =>
  adminClient().rpc('reap_stale_jobs', { p_timeout_seconds: timeout })

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`rp-${stamp}@teste.local`)

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_rp_${stamp}`,
      username: 'conta_reaper',
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
  await cleanupTestUsers([userA.id])
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

  it('manda para revisão o job que pode ter chegado ao Reddit', async () => {
    // Esta é a regra central: o resultado é desconhecido, e retentar poderia
    // publicar duas vezes.
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
    const desfechos = (data ?? []).map(
      (r: { kind: string; outcome: string }) => `${r.kind}:${r.outcome}`,
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

  it('espera maior que o timeout do reaper NÃO libera o job, com heartbeat', async () => {
    // Cenário: worker-A reivindica e precisa esperar 150s — 2,5x o timeout.
    // Sem heartbeat o reaper devolveria o job à fila e worker-B publicaria o
    // mesmo conteúdo. Simulamos empurrando locked_at para o passado e
    // renovando, em vez de dormir de verdade.
    const id = await jobPreso({ locked_by: 'worker-A', submit_attempted_at: null })

    for (const decorridos of [70, 140, 210]) {
      // Envelhece o lock além do timeout...
      await adminClient()
        .from('scheduled_posts')
        .update({
          locked_at: new Date(Date.now() - decorridos * 1000).toISOString(),
        })
        .eq('id', id)

      // ...e o heartbeat chega antes do reaper.
      const { data: renovou } = await adminClient().rpc('renew_job_lock', {
        p_kind: 'post',
        p_job_id: id,
        p_worker_id: 'worker-A',
      })
      expect(renovou).toBe(true)

      // O reaper roda e não deve encontrar nada.
      const { data: colhidos } = await reap(TIMEOUT)
      expect(
        (colhidos ?? []).map((r: { job_id: string }) => r.job_id),
      ).not.toContain(id)

      // E o claim de outro worker não pode pegar este job.
      const { data: roubo } = await adminClient().rpc('claim_due_posts', {
        p_worker_id: 'worker-B',
        p_batch: 10,
      })
      expect((roubo ?? []).map((r: { id: string }) => r.id)).not.toContain(id)
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
    // Este teste existe para provar que o anterior não passa por acidente.
    // Se o reaper não recuperasse jobs vencidos, o primeiro teste seria vazio.
    const id = await jobPreso({ locked_by: 'worker-A', submit_attempted_at: null })
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
    const { data } = await adminClient().rpc('renew_job_lock', {
      p_kind: 'post',
      p_job_id: id,
      p_worker_id: 'worker-B',
    })
    expect(data).toBe(false)
  })

  it('renovar um job que já saiu de processing retorna falso', async () => {
    // É assim que o worker descobre que perdeu a corrida e deve abortar.
    const id = await jobPreso({ status: 'scheduled', locked_by: null, locked_at: null })
    const { data } = await adminClient().rpc('renew_job_lock', {
      p_kind: 'post',
      p_job_id: id,
      p_worker_id: 'worker-A',
    })
    expect(data).toBe(false)
  })

  it('renova comentário também', async () => {
    const post = await jobPreso({ status: 'published' })
    const { data: com } = await adminClient()
      .from('scheduled_comments')
      .insert({
        owner_id: OWNER,
        scheduled_post_id: post,
        reddit_account_id: CONTA,
        body: 'comentário',
        mode: 'absolute',
        status: 'processing',
        locked_by: 'worker-A',
        locked_at: new Date().toISOString(),
        scheduled_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    const { data } = await adminClient().rpc('renew_job_lock', {
      p_kind: 'comment',
      p_job_id: com!.id,
      p_worker_id: 'worker-A',
    })
    expect(data).toBe(true)
  })
})
```

O primeiro teste é o que o ajuste pediu, e o segundo é o que lhe dá valor:
sem a contraprova, um reaper quebrado faria o primeiro passar sem nada provar.

- [ ] **Step 2: Rodar, verificar e commitar**

```powershell
npx vitest run tests/db/reaper.test.ts
npm run verify
```

```bash
git add -A
git commit -m "test: reaper trata a janela de incerteza e respeita heartbeat"
```

---

## Continua

O restante do plano — Tasks 3 a 15 — segue em arquivo próprio para manter
cada documento legível:

`docs/superpowers/plans/2026-08-16-plano-5b-submissao-e-infra.md`

Tasks 3 a 9 (submissão, runners, loop do worker, Docker) e 10 a 15
(reconciliação, Revisão, Fila, Histórico, Calendário, Dashboard).
