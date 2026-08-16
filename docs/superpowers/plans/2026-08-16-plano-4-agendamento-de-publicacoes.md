# Reddit Post Scheduler — Plano 4: Agendamento de Publicações

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar, validar e agendar publicações — com comentário automático opcional — de forma que o worker do Plano 5 encontre no banco apenas jobs coerentes e prontos para executar.

**Architecture:** O formulário coleta intenção; o `payload-builder` a traduz em um payload que a API do Reddit aceita, validando contra os `post_requirements` reais da comunidade. Data e hora são digitadas em horário local e convertidas para `timestamptz`, com horários inexistentes por DST recusados em vez de deslocados silenciosamente. Post e comentário nascem numa única transação SQL. A máquina de estados vive em triggers, não em convenção da aplicação.

**Tech Stack:** as dos Planos 1 a 3, mais `date-fns` 4.4 e `@date-fns/tz` 1.5.

**Spec:** `docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md` (revisão 2, aprovada)

**Planos anteriores:** 1, 2 e 3 — concluídos.

**Fase da spec coberta:** 4. As seções 5.5, 5.6, 5.7 (schema e máquina de estados) e 10 (payload) são implementadas aqui; o worker que as consome é o Plano 5.

## Global Constraints

As dos Planos 1 a 3 continuam valendo. Estas se somam:

- **Nenhuma chamada real ao Reddit em teste.** `undici.MockAgent` sempre; a suíte passa sem `REDDIT_CLIENT_ID`.
- **Falha ao ler requisitos bloqueia o agendamento.** Herdado do Plano 3: `REQUIREMENTS_UNAVAILABLE` nunca vira validação permissiva. O formulário recusa e explica, em vez de agendar às cegas.
- **`scheduled_at` é sempre `timestamptz`** (UTC no banco). A coluna `timezone` guarda o fuso digitado, para reexibir e reeditar corretamente.
- **Horário inexistente por DST é recusado**, nunca deslocado em silêncio.
- **Colunas do worker são inalcançáveis pelo usuário**: `reddit_post_id`, `locked_*`, `submit_attempted_at`, `retry_count` e afins só mudam pelo `service_role`, com grant por coluna **e** trigger — as duas barreiras independentes do Plano 2.
- **`needs_review` nunca volta para `scheduled` automaticamente.** Proibido por trigger, não por convenção.
- **Post e comentário nascem juntos ou não nascem.** Uma função SQL transacional; nada de dois inserts sequenciais da aplicação.
- **Teste que toca o banco vive em `tests/db/`.**
- **Portão de task:** `npm run verify` verde; o hook de pre-commit já bloqueia o resto.

## Pré-requisito

Nenhum. O plano inteiro é implementável e testável sem credenciais reais.

---

### Task 1: Schema de `scheduled_posts`

**Files:**
- Create: `supabase/migrations/<timestamp>_scheduled_posts.sql`
- Test: `tests/db/scheduled-posts.test.ts`

**Interfaces:**
- Consumes: `reddit_accounts`, `subreddits`
- Produces: tabela `public.scheduled_posts`, função `public.enforce_post_transition()`

**A decisão central do schema:** o payload é validado por CHECK constraint, não só pela aplicação. Um link post não pode ter `body`, porque a API do Reddit não aceita os dois — e quando o usuário fornece ambos, o `body` vira comentário automático (Task 5). O banco recusa a combinação inválida mesmo se a aplicação errar.

- [ ] **Step 1: Criar o arquivo de migration**

```powershell
npx supabase migration new scheduled_posts
```

- [ ] **Step 2: Escrever os testes falhando**

```ts
// tests/db/scheduled-posts.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string
let subB: string

async function criarConta(ownerId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_sp_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function criarSub(ownerId: string, contaId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_sp_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
      submission_type: 'any',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

function postBase(overrides: Record<string, unknown> = {}) {
  return {
    owner_id: userA.id,
    reddit_account_id: contaA,
    subreddit_id: subA,
    title: 'Título de teste',
    url: 'https://exemplo.com/video',
    body: null,
    post_kind: 'link',
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
    timezone: 'America/Sao_Paulo',
    ...overrides,
  }
}

async function criarPost(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert(postBase(overrides))
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`sp-a-${stamp}@teste.local`)
  userB = await createTestUser(`sp-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaB = await criarConta(userB.id, `b${stamp}`)
  subA = await criarSub(userA.id, contaA, `a${stamp}`)
  subB = await criarSub(userB.id, contaB, `b${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('coerência do payload', () => {
  it('aceita link post com url e sem body', async () => {
    await expect(criarPost()).resolves.toBeTruthy()
  })

  it('aceita self post com body e sem url', async () => {
    await expect(
      criarPost({ post_kind: 'self', url: null, body: 'texto' }),
    ).resolves.toBeTruthy()
  })

  it('recusa link post sem url', async () => {
    await expect(criarPost({ url: null })).rejects.toBeTruthy()
  })

  it('recusa link post com body: a API do Reddit não aceita os dois', async () => {
    await expect(criarPost({ body: 'texto junto do link' })).rejects.toBeTruthy()
  })

  it('recusa self post com url', async () => {
    await expect(
      criarPost({ post_kind: 'self', url: 'https://exemplo.com', body: 't' }),
    ).rejects.toBeTruthy()
  })

  it('recusa post_kind fora da lista', async () => {
    await expect(criarPost({ post_kind: 'image' })).rejects.toBeTruthy()
  })

  it('recusa título vazio', async () => {
    await expect(criarPost({ title: '   ' })).rejects.toBeTruthy()
  })

  it('recusa título acima de 300 caracteres', async () => {
    await expect(criarPost({ title: 'x'.repeat(301) })).rejects.toBeTruthy()
  })
})

describe('integridade entre owners', () => {
  it('recusa post cuja conta é de outro owner', async () => {
    await expect(
      criarPost({ reddit_account_id: contaB }),
    ).rejects.toBeTruthy()
  })

  it('recusa post cuja comunidade é de outro owner', async () => {
    await expect(criarPost({ subreddit_id: subB })).rejects.toBeTruthy()
  })

  it('recusa comunidade que não pertence à conta escolhida', async () => {
    // Mesmo owner, mas a comunidade é de outra conta dele.
    const outraConta = await criarConta(userA.id, `outra${Date.now()}`)
    const subOutra = await criarSub(userA.id, outraConta, `outra${Date.now()}`)
    await expect(criarPost({ subreddit_id: subOutra })).rejects.toBeTruthy()
  })
})

describe('RLS de scheduled_posts', () => {
  it('o usuário lê apenas os próprios posts', async () => {
    await criarPost()
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .select('id')
    expect(data).toHaveLength(0)
  })

  it('o usuário insere para si mesmo', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .insert(postBase())
    expect(error).toBeNull()
  })

  it('o usuário não insere no nome de outro', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .insert(postBase({ owner_id: userB.id }))
    expect(error).not.toBeNull()
  })

  it('o usuário não apaga posts: cancelar preserva o histórico', async () => {
    const id = await criarPost()
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .delete()
      .eq('id', id)
    expect(error).not.toBeNull()
  })
})

describe('colunas gerenciadas pelo worker', () => {
  it('authenticated não tem UPDATE nas colunas de execução', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select column_name from information_schema.column_privileges
         where grantee = 'authenticated' and table_name = 'scheduled_posts'
           and privilege_type = 'UPDATE' order by column_name`,
      ),
    )
    const editaveis = rows.map((r) => r.column_name)
    for (const proibida of [
      'reddit_post_id',
      'reddit_permalink',
      'locked_at',
      'locked_by',
      'submit_attempted_at',
      'retry_count',
      'published_at',
      'owner_id',
      'reddit_account_id',
      'subreddit_id',
    ]) {
      expect(editaveis).not.toContain(proibida)
    }
    expect(editaveis).toContain('title')
    expect(editaveis).toContain('scheduled_at')
  })

  it('o trigger recusa alteração das colunas de execução', async () => {
    const id = await criarPost()
    const colunas = ['reddit_post_id', 'locked_by', 'submit_attempted_at']
    for (const coluna of colunas) {
      await withSql((db) =>
        db.query(
          `grant update (${coluna}) on public.scheduled_posts to authenticated`,
        ),
      )
      try {
        const valor = coluna === 'submit_attempted_at' ? new Date().toISOString() : 'x'
        const { error } = await userClient(userA.accessToken)
          .from('scheduled_posts')
          .update({ [coluna]: valor })
          .eq('id', id)
        expect(error).not.toBeNull()
      } finally {
        await withSql((db) =>
          db.query(
            `revoke update (${coluna}) on public.scheduled_posts from authenticated`,
          ),
        )
      }
    }
  })
})

describe('máquina de estados', () => {
  async function transicionar(id: string, de: string, para: string) {
    await adminClient().from('scheduled_posts').update({ status: de }).eq('id', id)
    return adminClient().from('scheduled_posts').update({ status: para }).eq('id', id)
  }

  it('scheduled avança para processing', async () => {
    const id = await criarPost()
    expect((await transicionar(id, 'scheduled', 'processing')).error).toBeNull()
  })

  it('processing avança para published, failed e needs_review', async () => {
    for (const destino of ['published', 'failed', 'needs_review']) {
      const id = await criarPost()
      expect((await transicionar(id, 'processing', destino)).error).toBeNull()
    }
  })

  it('needs_review NUNCA volta para scheduled', async () => {
    // Regra central da spec: resultado ambíguo exige decisão humana, e
    // reagendar sozinho poderia duplicar a publicação.
    const id = await criarPost()
    expect(
      (await transicionar(id, 'needs_review', 'scheduled')).error,
    ).not.toBeNull()
  })

  it('needs_review pode ser resolvido manualmente', async () => {
    for (const destino of ['published', 'failed', 'cancelled']) {
      const id = await criarPost()
      expect((await transicionar(id, 'needs_review', destino)).error).toBeNull()
    }
  })

  it('published é terminal', async () => {
    for (const destino of ['scheduled', 'processing', 'failed', 'cancelled']) {
      const id = await criarPost()
      expect((await transicionar(id, 'published', destino)).error).not.toBeNull()
    }
  })

  it('cancelled é terminal', async () => {
    const id = await criarPost()
    expect((await transicionar(id, 'cancelled', 'scheduled')).error).not.toBeNull()
  })

  it('processing volta para scheduled apenas sem tentativa de envio', async () => {
    // É o caminho do reaper: worker morreu antes de enviar.
    const id = await criarPost()
    await adminClient()
      .from('scheduled_posts')
      .update({ status: 'processing', submit_attempted_at: null })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_posts')
      .update({ status: 'scheduled' })
      .eq('id', id)
    expect(error).toBeNull()
  })

  it('processing com envio tentado NÃO volta para scheduled', async () => {
    const id = await criarPost()
    await adminClient()
      .from('scheduled_posts')
      .update({
        status: 'processing',
        submit_attempted_at: new Date().toISOString(),
      })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_posts')
      .update({ status: 'scheduled' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })

  it('failed pode ser reagendado manualmente', async () => {
    const id = await criarPost()
    expect((await transicionar(id, 'failed', 'scheduled')).error).toBeNull()
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/db/scheduled-posts.test.ts`
Expected: FAIL — a relação não existe.

- [ ] **Step 4: Escrever a migration**

```sql
create table public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reddit_account_id uuid not null,
  subreddit_id uuid not null,

  -- Conteúdo
  title text not null,
  url text,
  body text,
  flair_id text,
  flair_text text,
  post_kind text not null check (post_kind in ('link', 'self')),
  nsfw boolean not null default false,
  spoiler boolean not null default false,

  -- Agendamento. scheduled_at é sempre UTC; timezone guarda o fuso digitado,
  -- para reexibir e reeditar o mesmo horário local.
  scheduled_at timestamptz not null,
  timezone text not null default 'America/Sao_Paulo',

  status text not null default 'scheduled'
    check (status in (
      'draft', 'scheduled', 'processing',
      'published', 'failed', 'cancelled', 'needs_review'
    )),

  -- Resultado (preenchido pelo worker)
  reddit_post_id text,
  reddit_fullname text,
  reddit_permalink text,
  error_code text,
  error_message text,
  retry_count integer not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  -- Gravado imediatamente antes de escrever a requisição de submissão. É o
  -- que separa "nunca saiu" de "pode ter chegado" quando o worker morre.
  submit_attempted_at timestamptz,
  review_reason text,
  resolved_by uuid references auth.users (id),
  resolved_at timestamptz,
  published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint titulo_nao_vazio check (length(btrim(title)) > 0),
  -- 300 é o teto duro do Reddit.
  constraint titulo_ate_300 check (length(title) <= 300),

  -- A API do Reddit não aceita link e corpo na mesma submissão. Quando o
  -- usuário fornece os dois, o corpo vira comentário automático.
  constraint payload_coerente check (
    (post_kind = 'link' and url is not null and length(btrim(url)) > 0
       and body is null)
    or (post_kind = 'self' and url is null)
  ),

  unique (id, owner_id),
  unique (id, reddit_account_id),

  -- Integridade entre owners garantida no banco, não só na aplicação.
  foreign key (reddit_account_id, owner_id)
    references public.reddit_accounts (id, owner_id) on delete cascade,
  foreign key (subreddit_id, owner_id)
    references public.subreddits (id, owner_id) on delete cascade,
  -- E a comunidade precisa pertencer à conta escolhida, não apenas ao mesmo
  -- usuário.
  foreign key (subreddit_id, reddit_account_id)
    references public.subreddits (id, reddit_account_id) on delete cascade
);

-- O worker varre por aqui: índice parcial mantém a busca barata mesmo com
-- histórico grande.
create index scheduled_posts_due_idx
  on public.scheduled_posts (scheduled_at)
  where status = 'scheduled';

create index scheduled_posts_owner_idx
  on public.scheduled_posts (owner_id, scheduled_at desc);

create index scheduled_posts_review_idx
  on public.scheduled_posts (owner_id)
  where status = 'needs_review';

-- Impede gravar duas vezes o mesmo post do Reddit.
create unique index scheduled_posts_reddit_post_idx
  on public.scheduled_posts (reddit_account_id, reddit_post_id)
  where reddit_post_id is not null;

alter table public.scheduled_posts enable row level security;

grant select, insert on public.scheduled_posts to authenticated;
grant update (
  title, url, body, flair_id, flair_text, post_kind,
  nsfw, spoiler, scheduled_at, timezone, status
) on public.scheduled_posts to authenticated;
grant all on public.scheduled_posts to service_role;

create policy "scheduled_posts_select_own"
  on public.scheduled_posts for select
  to authenticated
  using ( (select auth.uid()) = owner_id );

create policy "scheduled_posts_insert_own"
  on public.scheduled_posts for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and status in ('draft', 'scheduled')
  );

create policy "scheduled_posts_update_own"
  on public.scheduled_posts for update
  to authenticated
  using ( (select auth.uid()) = owner_id )
  with check ( (select auth.uid()) = owner_id );

-- Sem policy de DELETE: cancelar preserva o histórico.

create trigger scheduled_posts_set_updated_at
  before update on public.scheduled_posts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Máquina de estados
-- ---------------------------------------------------------------
-- Vive aqui, e não na aplicação, porque é invariante do domínio: um caminho
-- novo de código não pode inventar uma transição.
--
-- SECURITY INVOKER para enxergar o papel real do chamador — mesma razão do
-- trigger de reddit_accounts.
create or replace function public.enforce_post_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_admin boolean := current_user in ('service_role', 'postgres', 'supabase_admin');
begin
  if new.status = old.status then
    return new;
  end if;

  -- needs_review só sai por decisão humana registrada, nunca de volta para a
  -- fila: o resultado é ambíguo e reagendar sozinho pode duplicar a publicação.
  if old.status = 'needs_review'
     and new.status not in ('published', 'failed', 'cancelled') then
    raise exception
      'De needs_review só é possível resolver manualmente para published, failed ou cancelled.'
      using errcode = '23514';
  end if;

  if old.status = 'published' then
    raise exception 'Uma publicação concluída não muda de estado.'
      using errcode = '23514';
  end if;

  if old.status = 'cancelled' then
    raise exception 'Uma publicação cancelada não muda de estado.'
      using errcode = '23514';
  end if;

  -- Caminho do reaper: devolver à fila só é seguro quando a requisição
  -- comprovadamente não saiu.
  if old.status = 'processing' and new.status = 'scheduled'
     and old.submit_attempted_at is not null then
    raise exception
      'Job com envio já tentado não volta para a fila: o resultado é desconhecido.'
      using errcode = '23514';
  end if;

  if not v_admin then
    -- O usuário só cancela, e só a partir de estados que ainda não executaram.
    if new.status <> 'cancelled'
       or old.status not in ('draft', 'scheduled') then
      raise exception
        'Só é possível cancelar publicações que ainda não entraram em execução.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_post_transition()
  from public, anon, authenticated;

create trigger scheduled_posts_enforce_transition
  before update on public.scheduled_posts
  for each row execute function public.enforce_post_transition();

-- ---------------------------------------------------------------
-- Colunas gerenciadas pelo worker
-- ---------------------------------------------------------------
-- Segunda barreira, independente do grant por coluna: se um grant for
-- afrouxado por engano, o trigger continua recusando.
create or replace function public.protect_post_execution_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if new.owner_id is distinct from old.owner_id
     or new.reddit_account_id is distinct from old.reddit_account_id
     or new.subreddit_id is distinct from old.subreddit_id
     or new.reddit_post_id is distinct from old.reddit_post_id
     or new.reddit_fullname is distinct from old.reddit_fullname
     or new.reddit_permalink is distinct from old.reddit_permalink
     or new.error_code is distinct from old.error_code
     or new.error_message is distinct from old.error_message
     or new.retry_count is distinct from old.retry_count
     or new.next_attempt_at is distinct from old.next_attempt_at
     or new.locked_at is distinct from old.locked_at
     or new.locked_by is distinct from old.locked_by
     or new.submit_attempted_at is distinct from old.submit_attempted_at
     or new.review_reason is distinct from old.review_reason
     or new.published_at is distinct from old.published_at
  then
    raise exception
      'Estas colunas são mantidas pelo sistema e não podem ser alteradas diretamente.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.protect_post_execution_columns()
  from public, anon, authenticated;

create trigger scheduled_posts_protect_execution
  before update on public.scheduled_posts
  for each row execute function public.protect_post_execution_columns();
```

- [ ] **Step 5: Aplicar e rodar**

```powershell
npx supabase db reset
npx vitest run tests/db/scheduled-posts.test.ts
```

Expected: PASS

- [ ] **Step 6: Advisors, verify e commit**

```powershell
npx supabase db advisors --local --type security
npm run verify
```

```bash
git add -A
git commit -m "feat: schema de publicacoes agendadas com maquina de estados"
```

---

### Task 2: Schema de `scheduled_comments`

**Files:**
- Create: `supabase/migrations/<timestamp>_scheduled_comments.sql`
- Test: `tests/db/scheduled-comments.test.ts`

**Interfaces:**
- Consumes: `scheduled_posts`
- Produces: tabela `public.scheduled_comments`

**Invariante:** o comentário é sempre publicado pela **mesma conta** que publicou o post — garantido por FK composta `(scheduled_post_id, reddit_account_id)`, não por checagem da aplicação.

- [ ] **Step 1: Criar a migration**

```powershell
npx supabase migration new scheduled_comments
```

- [ ] **Step 2: Escrever os testes falhando**

```ts
// tests/db/scheduled-comments.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaOutra: string
let subA: string
let postA: string

async function criarConta(ownerId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_sc2_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function criarSub(ownerId: string, contaId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_sc2_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

function comentarioBase(overrides: Record<string, unknown> = {}) {
  return {
    owner_id: userA.id,
    scheduled_post_id: postA,
    reddit_account_id: contaA,
    body: 'Comentário automático',
    mode: 'immediate',
    ...overrides,
  }
}

async function criarComentario(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_comments')
    .insert(comentarioBase(overrides))
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`sc2-a-${stamp}@teste.local`)
  userB = await createTestUser(`sc2-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaOutra = await criarConta(userA.id, `o${stamp}`)
  subA = await criarSub(userA.id, contaA, `a${stamp}`)

  const { data } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: contaA,
      subreddit_id: subA,
      title: 'Post com comentário',
      url: 'https://exemplo.com/x',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
    })
    .select('id')
    .single()
  postA = data!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('coerência do modo', () => {
  it('aceita modo immediate sem delay nem horário', async () => {
    await expect(criarComentario()).resolves.toBeTruthy()
  })

  it('aceita modo delay com minutos', async () => {
    await expect(
      criarComentario({ mode: 'delay', delay_minutes: 10 }),
    ).resolves.toBeTruthy()
  })

  it('aceita modo absolute com horário', async () => {
    await expect(
      criarComentario({
        mode: 'absolute',
        scheduled_at: new Date(Date.now() + 7200_000).toISOString(),
      }),
    ).resolves.toBeTruthy()
  })

  it('recusa modo delay sem minutos', async () => {
    await expect(criarComentario({ mode: 'delay' })).rejects.toBeTruthy()
  })

  it('recusa modo absolute sem horário', async () => {
    await expect(criarComentario({ mode: 'absolute' })).rejects.toBeTruthy()
  })

  it('recusa modo immediate com minutos', async () => {
    await expect(
      criarComentario({ mode: 'immediate', delay_minutes: 5 }),
    ).rejects.toBeTruthy()
  })

  it('recusa delay negativo', async () => {
    await expect(
      criarComentario({ mode: 'delay', delay_minutes: -1 }),
    ).rejects.toBeTruthy()
  })

  it('recusa corpo vazio', async () => {
    await expect(criarComentario({ body: '   ' })).rejects.toBeTruthy()
  })
})

describe('vínculo com o post', () => {
  it('recusa comentário de conta diferente da do post', async () => {
    // O comentário precisa sair pela mesma conta que publicou.
    await expect(
      criarComentario({ reddit_account_id: contaOutra }),
    ).rejects.toBeTruthy()
  })

  it('recusa comentário cujo owner diverge do post', async () => {
    await expect(criarComentario({ owner_id: userB.id })).rejects.toBeTruthy()
  })

  it('apagar o post apaga os comentários em cascata', async () => {
    const { data: post } = await adminClient()
      .from('scheduled_posts')
      .insert({
        owner_id: userA.id,
        reddit_account_id: contaA,
        subreddit_id: subA,
        title: 'Post temporário',
        post_kind: 'self',
        body: 'texto',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
      })
      .select('id')
      .single()

    await criarComentario({ scheduled_post_id: post!.id })
    await adminClient().from('scheduled_posts').delete().eq('id', post!.id)

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('id')
      .eq('scheduled_post_id', post!.id)
    expect(data).toHaveLength(0)
  })
})

describe('RLS de scheduled_comments', () => {
  it('o usuário B não enxerga comentários de A', async () => {
    await criarComentario()
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .select('id')
    expect(data).toHaveLength(0)
  })

  it('o usuário A enxerga os próprios', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('scheduled_comments')
      .select('id')
    expect((data ?? []).length).toBeGreaterThan(0)
  })
})

describe('máquina de estados do comentário', () => {
  it('needs_review não volta para scheduled', async () => {
    const id = await criarComentario()
    await adminClient()
      .from('scheduled_comments')
      .update({ status: 'needs_review' })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_comments')
      .update({ status: 'scheduled' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })

  it('published é terminal', async () => {
    const id = await criarComentario()
    await adminClient()
      .from('scheduled_comments')
      .update({ status: 'published' })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_comments')
      .update({ status: 'failed' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/db/scheduled-comments.test.ts`
Expected: FAIL

- [ ] **Step 4: Escrever a migration**

```sql
create table public.scheduled_comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  scheduled_post_id uuid not null,
  reddit_account_id uuid not null,

  body text not null,

  -- immediate: assim que o post publicar
  -- delay: X minutos depois da publicação real
  -- absolute: em um horário fixo, desde que o post já tenha publicado
  mode text not null check (mode in ('immediate', 'delay', 'absolute')),
  delay_minutes integer check (delay_minutes >= 0),
  -- Nulo nos modos immediate e delay até o post publicar: o horário só existe
  -- depois que sabemos published_at real.
  scheduled_at timestamptz,

  status text not null default 'scheduled'
    check (status in (
      'draft', 'scheduled', 'processing',
      'published', 'failed', 'cancelled', 'needs_review'
    )),

  reddit_comment_id text,
  reddit_permalink text,
  error_code text,
  error_message text,
  retry_count integer not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  submit_attempted_at timestamptz,
  review_reason text,
  resolved_by uuid references auth.users (id),
  resolved_at timestamptz,
  published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint corpo_nao_vazio check (length(btrim(body)) > 0),
  constraint modo_coerente check (
    (mode = 'immediate' and delay_minutes is null)
    or (mode = 'delay' and delay_minutes is not null)
    or (mode = 'absolute' and scheduled_at is not null)
  ),

  foreign key (scheduled_post_id, owner_id)
    references public.scheduled_posts (id, owner_id) on delete cascade,
  -- O comentário sai sempre pela MESMA conta que publicou o post.
  foreign key (scheduled_post_id, reddit_account_id)
    references public.scheduled_posts (id, reddit_account_id) on delete cascade
);

create index scheduled_comments_post_idx
  on public.scheduled_comments (scheduled_post_id);

create index scheduled_comments_due_idx
  on public.scheduled_comments (scheduled_at)
  where status = 'scheduled';

create index scheduled_comments_owner_idx
  on public.scheduled_comments (owner_id);

alter table public.scheduled_comments enable row level security;

grant select, insert on public.scheduled_comments to authenticated;
grant update (body, mode, delay_minutes, scheduled_at, status)
  on public.scheduled_comments to authenticated;
grant all on public.scheduled_comments to service_role;

create policy "scheduled_comments_select_own"
  on public.scheduled_comments for select
  to authenticated
  using ( (select auth.uid()) = owner_id );

create policy "scheduled_comments_insert_own"
  on public.scheduled_comments for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and status in ('draft', 'scheduled')
  );

create policy "scheduled_comments_update_own"
  on public.scheduled_comments for update
  to authenticated
  using ( (select auth.uid()) = owner_id )
  with check ( (select auth.uid()) = owner_id );

create trigger scheduled_comments_set_updated_at
  before update on public.scheduled_comments
  for each row execute function public.set_updated_at();

-- A mesma máquina de estados dos posts vale para comentários.
create or replace function public.enforce_comment_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_admin boolean := current_user in ('service_role', 'postgres', 'supabase_admin');
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'needs_review'
     and new.status not in ('published', 'failed', 'cancelled') then
    raise exception
      'De needs_review só é possível resolver manualmente.'
      using errcode = '23514';
  end if;

  if old.status in ('published', 'cancelled') then
    raise exception 'Comentário concluído ou cancelado não muda de estado.'
      using errcode = '23514';
  end if;

  if old.status = 'processing' and new.status = 'scheduled'
     and old.submit_attempted_at is not null then
    raise exception
      'Comentário com envio já tentado não volta para a fila.'
      using errcode = '23514';
  end if;

  if not v_admin then
    if new.status <> 'cancelled'
       or old.status not in ('draft', 'scheduled') then
      raise exception
        'Só é possível cancelar comentários que ainda não entraram em execução.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_comment_transition()
  from public, anon, authenticated;

create trigger scheduled_comments_enforce_transition
  before update on public.scheduled_comments
  for each row execute function public.enforce_comment_transition();
```

- [ ] **Step 5: Aplicar, verificar e commitar**

```powershell
npx supabase db reset
npx vitest run tests/db/scheduled-comments.test.ts
npx supabase db advisors --local --type security
npm run verify
```

```bash
git add -A
git commit -m "feat: schema de comentarios programados"
```

---

### Task 3: Conversão de horário local para UTC

**Files:**
- Create: `src/lib/scheduling/timezone.ts`
- Test: `tests/scheduling/timezone.test.ts`

**Interfaces:**
- Produces:
  - `type WallTime` — `{ date: string; time: string; timeZone: string }` (`'2026-08-16'`, `'10:30'`)
  - `toUtc(wall: WallTime): { utc: Date; ambiguous: boolean }`
  - `fromUtc(utc: Date, timeZone: string): { date: string; time: string }`
  - `class NonexistentTimeError extends Error`
  - `SUPPORTED_TIME_ZONES` — lista para o seletor da UI

**O que a verificação empírica mostrou** (undici à parte, isto é sobre `@date-fns/tz` 1.5):

| Caso | `TZDate` faz | Nossa decisão |
|---|---|---|
| Horário normal | round-trip exato | aceitar |
| **Gap** — `2026-03-08 02:30` em `America/New_York` não existe | desloca para `03:30` silenciosamente | **recusar** com `NonexistentTimeError` |
| **Ambíguo** — `2026-11-01 01:30` em `America/New_York` ocorre duas vezes | escolhe a primeira ocorrência | aceitar a primeira, sinalizando `ambiguous: true` para a UI avisar |

Deslocar em silêncio publicaria uma hora depois do combinado sem ninguém saber.
Recusar a ambiguidade seria exagero: a diferença é de uma hora e a primeira
ocorrência é a interpretação usual — mas o usuário merece saber.

Detecção, sem depender de API que não existe:
- **gap**: converter para UTC e voltar; se o horário local resultante difere do digitado, o horário não existe;
- **ambiguidade**: se `utc` e `utc + 1h` produzem o mesmo horário local, há duas instâncias.

- [ ] **Step 1: Instalar as dependências**

```powershell
npm install date-fns@4.4.0 @date-fns/tz@1.5.0
```

- [ ] **Step 2: Escrever os testes falhando**

```ts
// tests/scheduling/timezone.test.ts
import { describe, expect, it } from 'vitest'
import {
  fromUtc,
  NonexistentTimeError,
  SUPPORTED_TIME_ZONES,
  toUtc,
} from '@/lib/scheduling/timezone'

const SP = 'America/Sao_Paulo'
const NY = 'America/New_York'

describe('toUtc em horário sem DST', () => {
  it('converte horário de São Paulo para UTC', () => {
    const { utc } = toUtc({ date: '2026-08-16', time: '10:30', timeZone: SP })
    // São Paulo é UTC-3 o ano todo desde 2019.
    expect(utc.toISOString()).toBe('2026-08-16T13:30:00.000Z')
  })

  it('faz round-trip preservando o horário local', () => {
    const wall = { date: '2026-08-16', time: '10:30', timeZone: SP }
    const { utc } = toUtc(wall)
    expect(fromUtc(utc, SP)).toEqual({ date: '2026-08-16', time: '10:30' })
  })

  it('não sinaliza ambiguidade em horário comum', () => {
    expect(toUtc({ date: '2026-08-16', time: '10:30', timeZone: SP }).ambiguous)
      .toBe(false)
  })

  it('converte meia-noite corretamente', () => {
    const { utc } = toUtc({ date: '2026-08-16', time: '00:00', timeZone: SP })
    expect(fromUtc(utc, SP)).toEqual({ date: '2026-08-16', time: '00:00' })
  })

  it('atravessa a virada do dia em UTC', () => {
    // 22:00 em SP é 01:00 do dia seguinte em UTC.
    const { utc } = toUtc({ date: '2026-08-16', time: '22:00', timeZone: SP })
    expect(utc.toISOString()).toBe('2026-08-17T01:00:00.000Z')
  })
})

describe('toUtc no salto de DST (horário inexistente)', () => {
  it('recusa 02:30 em 08/03/2026 em Nova York', () => {
    // O relógio pula de 02:00 para 03:00: esse horário não existe.
    expect(() =>
      toUtc({ date: '2026-03-08', time: '02:30', timeZone: NY }),
    ).toThrow(NonexistentTimeError)
  })

  it('a mensagem explica o motivo em português', () => {
    try {
      toUtc({ date: '2026-03-08', time: '02:30', timeZone: NY })
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).toMatch(/não existe/i)
      expect((e as Error).message).toMatch(/horário de verão/i)
    }
  })

  it('aceita 01:30, que existe', () => {
    expect(() =>
      toUtc({ date: '2026-03-08', time: '01:30', timeZone: NY }),
    ).not.toThrow()
  })

  it('aceita 03:30, que existe', () => {
    expect(() =>
      toUtc({ date: '2026-03-08', time: '03:30', timeZone: NY }),
    ).not.toThrow()
  })
})

describe('toUtc no retorno de DST (horário ambíguo)', () => {
  it('sinaliza ambiguidade em 01:30 de 01/11/2026 em Nova York', () => {
    // Esse horário acontece duas vezes: uma em EDT, outra em EST.
    const { ambiguous } = toUtc({
      date: '2026-11-01',
      time: '01:30',
      timeZone: NY,
    })
    expect(ambiguous).toBe(true)
  })

  it('escolhe a primeira ocorrência', () => {
    const { utc } = toUtc({ date: '2026-11-01', time: '01:30', timeZone: NY })
    // Primeira ocorrência ainda em horário de verão (UTC-4) => 05:30Z.
    expect(utc.toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('não lança: ambiguidade é aviso, não erro', () => {
    expect(() =>
      toUtc({ date: '2026-11-01', time: '01:30', timeZone: NY }),
    ).not.toThrow()
  })

  it('horário fora da janela ambígua não é sinalizado', () => {
    expect(
      toUtc({ date: '2026-11-01', time: '03:30', timeZone: NY }).ambiguous,
    ).toBe(false)
  })
})

describe('fromUtc', () => {
  it('devolve data e hora locais no fuso pedido', () => {
    const utc = new Date('2026-08-16T13:30:00.000Z')
    expect(fromUtc(utc, SP)).toEqual({ date: '2026-08-16', time: '10:30' })
  })

  it('o mesmo instante rende horários diferentes em fusos diferentes', () => {
    const utc = new Date('2026-08-16T13:30:00.000Z')
    expect(fromUtc(utc, SP).time).toBe('10:30')
    expect(fromUtc(utc, NY).time).toBe('09:30')
  })

  it('preenche com zero à esquerda', () => {
    const utc = new Date('2026-08-16T12:05:00.000Z')
    expect(fromUtc(utc, SP)).toEqual({ date: '2026-08-16', time: '09:05' })
  })
})

describe('validação de entrada', () => {
  it('recusa fuso desconhecido', () => {
    expect(() =>
      toUtc({ date: '2026-08-16', time: '10:30', timeZone: 'Marte/Olympus' }),
    ).toThrow()
  })

  it('recusa data malformada', () => {
    expect(() =>
      toUtc({ date: '16/08/2026', time: '10:30', timeZone: SP }),
    ).toThrow()
  })

  it('recusa hora malformada', () => {
    expect(() =>
      toUtc({ date: '2026-08-16', time: '25:00', timeZone: SP }),
    ).toThrow()
  })
})

describe('SUPPORTED_TIME_ZONES', () => {
  it('inclui o padrão da spec', () => {
    expect(SUPPORTED_TIME_ZONES).toContain('America/Sao_Paulo')
  })

  it('todos os fusos são válidos para o Intl', () => {
    for (const tz of SUPPORTED_TIME_ZONES) {
      expect(() =>
        new Intl.DateTimeFormat('pt-BR', { timeZone: tz }),
      ).not.toThrow()
    }
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/scheduling/timezone.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 4: Implementar**

```ts
// src/lib/scheduling/timezone.ts
import { TZDate } from '@date-fns/tz'

export type WallTime = {
  /** AAAA-MM-DD */
  date: string
  /** HH:MM em 24 horas */
  time: string
  timeZone: string
}

export class NonexistentTimeError extends Error {
  constructor(date: string, time: string, timeZone: string) {
    super(
      `O horário ${time} de ${date} não existe no fuso ${timeZone}: ` +
        'o relógio avança nesse momento por causa do horário de verão. ' +
        'Escolha outro horário.',
    )
    this.name = 'NonexistentTimeError'
  }
}

/**
 * Fusos oferecidos no seletor. Curto de propósito: a lista completa da IANA
 * tem centenas de entradas e nenhuma serventia para este produto.
 */
export const SUPPORTED_TIME_ZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/Fortaleza',
  'America/Cuiaba',
  'America/Rio_Branco',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Berlin',
  'UTC',
] as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone })
  } catch {
    throw new Error(`Fuso horário desconhecido: ${timeZone}`)
  }
}

const dois = (n: number) => String(n).padStart(2, '0')

/**
 * Converte data e hora locais para o instante UTC correspondente.
 *
 * Dois casos de borda do horário de verão importam:
 *
 * - **Horário inexistente** (o relógio salta para frente): a biblioteca
 *   desloca silenciosamente para depois do salto, o que publicaria uma hora
 *   depois do combinado. Detectamos comparando o horário local de volta com o
 *   digitado, e recusamos.
 * - **Horário ambíguo** (o relógio volta e a hora ocorre duas vezes):
 *   escolhemos a primeira ocorrência, que é a interpretação usual, e
 *   devolvemos `ambiguous: true` para a UI avisar.
 */
export function toUtc(wall: WallTime): { utc: Date; ambiguous: boolean } {
  const { date, time, timeZone } = wall

  if (!DATE_RE.test(date)) throw new Error(`Data inválida: ${date}`)
  if (!TIME_RE.test(time)) throw new Error(`Horário inválido: ${time}`)
  assertTimeZone(timeZone)

  const [ano, mes, dia] = date.split('-').map(Number)
  const [hora, minuto] = time.split(':').map(Number)

  const zoned = new TZDate(ano, mes - 1, dia, hora, minuto, 0, timeZone)
  const utc = new Date(zoned.getTime())

  // Round-trip: se o horário local não volta igual, ele não existe no fuso.
  const devolta = fromUtc(utc, timeZone)
  if (devolta.date !== date || devolta.time !== time) {
    throw new NonexistentTimeError(date, time, timeZone)
  }

  // Se o instante uma hora depois rende o mesmo horário local, a hora ocorre
  // duas vezes nesse dia.
  const umaHoraDepois = new Date(utc.getTime() + 3600_000)
  const depois = fromUtc(umaHoraDepois, timeZone)
  const ambiguous = depois.date === date && depois.time === time

  return { utc, ambiguous }
}

/** Converte um instante UTC para data e hora locais no fuso pedido. */
export function fromUtc(
  utc: Date,
  timeZone: string,
): { date: string; time: string } {
  assertTimeZone(timeZone)
  const zoned = new TZDate(utc.getTime(), timeZone)
  return {
    date: `${zoned.getFullYear()}-${dois(zoned.getMonth() + 1)}-${dois(
      zoned.getDate(),
    )}`,
    time: `${dois(zoned.getHours())}:${dois(zoned.getMinutes())}`,
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/scheduling/timezone.test.ts`
Expected: PASS

Se o teste de ambiguidade falhar dizendo que `ambiguous` é `false`, confira se
`fromUtc` está usando `TZDate` e não o `Date` nativo — o `Date` usa o fuso da
máquina e mascararia a detecção.

- [ ] **Step 6: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: conversao de horario local para UTC com tratamento de DST"
```

---

### Task 4: Construção e validação do payload

**Files:**
- Create: `src/lib/scheduling/payload-builder.ts`
- Test: `tests/scheduling/payload-builder.test.ts`

**Interfaces:**
- Consumes: `PostRequirements` (Plano 3)
- Produces:
  - `type PostIntent` — o que o usuário quis: `{ title, url?, body?, flairId?, nsfw, spoiler }`
  - `type BuiltPayload` — `{ postKind, title, url, body, flairId, nsfw, spoiler, commentBody }`
  - `buildPayload(intent, requirements, subreddit): BuiltPayload`
  - `class PayloadError extends Error` com `field` e `userMessage`

**A regra central, da seção 10 da spec:**

| Entrada | `post_kind` | `body` do post | Comentário automático |
|---|---|---|---|
| título + link | `link` | — | — |
| título + texto | `self` | o texto | — |
| **título + link + texto** | `link` | — | **o texto** |

O terceiro caso é o que a spec chama de "não inventar workaround": a API não
aceita link e corpo juntos, então o corpo vira comentário — usando endpoint
oficial, e apenas quando o usuário confirma.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/scheduling/payload-builder.test.ts
import { describe, expect, it } from 'vitest'
import { buildPayload, PayloadError } from '@/lib/scheduling/payload-builder'
import { FIELD_DEFAULTS } from '@/lib/reddit/requirements'

const subreddit = {
  name: 'minhacomunidade',
  submissionType: 'any' as const,
  linkFlairEnabled: true,
}

const base = {
  title: 'Título válido',
  nsfw: false,
  spoiler: false,
  allowCommentFallback: true,
}

const req = (o: Partial<typeof FIELD_DEFAULTS> = {}) => ({
  ...FIELD_DEFAULTS,
  ...o,
})

describe('escolha do tipo de publicação', () => {
  it('título + link vira link post', () => {
    const p = buildPayload(
      { ...base, url: 'https://exemplo.com/v' },
      req(),
      subreddit,
    )
    expect(p.postKind).toBe('link')
    expect(p.url).toBe('https://exemplo.com/v')
    expect(p.body).toBeNull()
    expect(p.commentBody).toBeNull()
  })

  it('título + texto vira self post', () => {
    const p = buildPayload({ ...base, body: 'meu texto' }, req(), subreddit)
    expect(p.postKind).toBe('self')
    expect(p.body).toBe('meu texto')
    expect(p.url).toBeNull()
    expect(p.commentBody).toBeNull()
  })

  it('título + link + texto vira link post com o texto em comentário', () => {
    // A API do Reddit não aceita os dois na mesma submissão.
    const p = buildPayload(
      { ...base, url: 'https://exemplo.com/v', body: 'meu texto' },
      req(),
      subreddit,
    )
    expect(p.postKind).toBe('link')
    expect(p.url).toBe('https://exemplo.com/v')
    expect(p.body).toBeNull()
    expect(p.commentBody).toBe('meu texto')
  })

  it('sem link e sem texto é recusado', () => {
    expect(() => buildPayload(base, req(), subreddit)).toThrow(PayloadError)
  })

  it('link + texto sem confirmação do usuário é recusado', () => {
    // O redirecionamento para comentário precisa ser escolha consciente.
    expect(() =>
      buildPayload(
        {
          ...base,
          url: 'https://exemplo.com/v',
          body: 'texto',
          allowCommentFallback: false,
        },
        req(),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('restrições da comunidade', () => {
  it('recusa link post onde a comunidade só aceita texto', () => {
    expect(() =>
      buildPayload({ ...base, url: 'https://exemplo.com/v' }, req(), {
        ...subreddit,
        submissionType: 'self',
      }),
    ).toThrow(PayloadError)
  })

  it('recusa self post onde a comunidade só aceita link', () => {
    expect(() =>
      buildPayload({ ...base, body: 'texto' }, req(), {
        ...subreddit,
        submissionType: 'link',
      }),
    ).toThrow(PayloadError)
  })

  it('recusa link post quando o corpo é obrigatório', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://exemplo.com/v' },
        req({ bodyRestrictionPolicy: 'required' }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa self post quando o corpo não é permitido', () => {
    expect(() =>
      buildPayload(
        { ...base, body: 'texto' },
        req({ bodyRestrictionPolicy: 'notAllowed' }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('exige flair quando a comunidade exige', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://exemplo.com/v' },
        req({ isFlairRequired: true }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('aceita quando o flair exigido é fornecido', () => {
    const p = buildPayload(
      { ...base, url: 'https://exemplo.com/v', flairId: 'abc' },
      req({ isFlairRequired: true }),
      subreddit,
    )
    expect(p.flairId).toBe('abc')
  })
})

describe('validação do título', () => {
  it('recusa título abaixo do mínimo da comunidade', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'oi', url: 'https://exemplo.com/v' },
        req({ titleMinLength: 10 }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa título acima do máximo da comunidade', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'x'.repeat(60), url: 'https://exemplo.com/v' },
        req({ titleMaxLength: 50 }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa título com termo proibido', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'isto é proibido aqui', url: 'https://exemplo.com/v' },
        req({ titleBlacklistedStrings: ['proibido'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('a comparação de termo proibido ignora maiúsculas', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'isto é PROIBIDO', url: 'https://exemplo.com/v' },
        req({ titleBlacklistedStrings: ['proibido'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('validação do corpo', () => {
  it('recusa corpo com termo proibido', () => {
    expect(() =>
      buildPayload(
        { ...base, body: 'contém spam aqui' },
        req({ bodyBlacklistedStrings: ['spam'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('valida também o texto que vira comentário', () => {
    // O texto redirecionado continua sendo conteúdo do usuário.
    expect(() =>
      buildPayload(
        { ...base, url: 'https://exemplo.com/v', body: 'contém spam' },
        req({ bodyBlacklistedStrings: ['spam'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('validação do domínio', () => {
  it('recusa domínio fora da lista permitida', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://naopermitido.com/v' },
        req({ domainWhitelist: ['youtube.com'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('aceita domínio da lista permitida', () => {
    const p = buildPayload(
      { ...base, url: 'https://youtube.com/watch?v=1' },
      req({ domainWhitelist: ['youtube.com'] }),
      subreddit,
    )
    expect(p.url).toContain('youtube.com')
  })

  it('aceita subdomínio de domínio permitido', () => {
    const p = buildPayload(
      { ...base, url: 'https://www.youtube.com/watch?v=1' },
      req({ domainWhitelist: ['youtube.com'] }),
      subreddit,
    )
    expect(p.url).toContain('youtube.com')
  })

  it('recusa domínio da lista bloqueada', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://spam.com/v' },
        req({ domainBlacklist: ['spam.com'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa URL malformada', () => {
    expect(() =>
      buildPayload({ ...base, url: 'nao-e-url' }, req(), subreddit),
    ).toThrow(PayloadError)
  })

  it('recusa esquema que não é http nem https', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'javascript:alert(1)' },
        req(),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('mensagens de erro', () => {
  it('todo erro aponta o campo e explica em português', () => {
    try {
      buildPayload(base, req(), subreddit)
      throw new Error('deveria ter lançado')
    } catch (e) {
      const erro = e as PayloadError
      expect(erro.field).toBeTruthy()
      expect(erro.userMessage.length).toBeGreaterThan(10)
      expect(erro.userMessage).not.toMatch(/undefined|null/)
    }
  })

  it('a recusa de link + texto explica a limitação da API', () => {
    try {
      buildPayload(
        {
          ...base,
          url: 'https://exemplo.com/v',
          body: 'texto',
          allowCommentFallback: false,
        },
        req(),
        subreddit,
      )
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as PayloadError).userMessage).toMatch(/coment/i)
    }
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/scheduling/payload-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar**

```ts
// src/lib/scheduling/payload-builder.ts
import type { PostRequirements } from '@/lib/reddit/requirements'

export type PostIntent = {
  title: string
  url?: string
  body?: string
  flairId?: string
  nsfw: boolean
  spoiler: boolean
  /**
   * O usuário confirmou que, havendo link e texto, o texto vira comentário
   * automático. Sem confirmação, a combinação é recusada em vez de decidida
   * pelo sistema.
   */
  allowCommentFallback: boolean
}

export type SubredditInfo = {
  name: string
  submissionType: 'any' | 'link' | 'self'
  linkFlairEnabled: boolean
}

export type BuiltPayload = {
  postKind: 'link' | 'self'
  title: string
  url: string | null
  body: string | null
  flairId: string | null
  nsfw: boolean
  spoiler: boolean
  /** Texto que vira comentário automático, quando houver. */
  commentBody: string | null
}

export class PayloadError extends Error {
  readonly field: string
  readonly userMessage: string

  constructor(field: string, userMessage: string) {
    super(`${field}: ${userMessage}`)
    this.name = 'PayloadError'
    this.field = field
    this.userMessage = userMessage
  }
}

function normalizarUrl(bruta: string): URL {
  let url: URL
  try {
    url = new URL(bruta)
  } catch {
    throw new PayloadError('url', 'O link informado não é uma URL válida.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PayloadError('url', 'O link precisa começar com http ou https.')
  }
  return url
}

/** Casa domínio e subdomínios: www.youtube.com casa com youtube.com. */
function dominioCasa(host: string, dominio: string): boolean {
  const h = host.toLowerCase()
  const d = dominio.toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

function contemTermo(texto: string, termos: string[]): string | null {
  const alvo = texto.toLowerCase()
  return termos.find((t) => t && alvo.includes(t.toLowerCase())) ?? null
}

/**
 * Traduz a intenção do usuário em um payload que a API do Reddit aceita.
 *
 * Lança PayloadError na primeira violação, com o campo responsável — o
 * formulário usa isso para destacar o campo certo.
 */
export function buildPayload(
  intent: PostIntent,
  requirements: PostRequirements,
  subreddit: SubredditInfo,
): BuiltPayload {
  const title = intent.title.trim()
  const url = intent.url?.trim() || null
  const body = intent.body?.trim() || null

  // --- título ---
  if (title.length === 0) {
    throw new PayloadError('title', 'Informe o título da publicação.')
  }
  if (title.length > requirements.titleMaxLength) {
    throw new PayloadError(
      'title',
      `O título passa do limite desta comunidade (${requirements.titleMaxLength} caracteres).`,
    )
  }
  if (
    requirements.titleMinLength !== null &&
    title.length < requirements.titleMinLength
  ) {
    throw new PayloadError(
      'title',
      `Esta comunidade exige título com pelo menos ${requirements.titleMinLength} caracteres.`,
    )
  }
  const termoTitulo = contemTermo(title, requirements.titleBlacklistedStrings)
  if (termoTitulo) {
    throw new PayloadError(
      'title',
      `Esta comunidade não permite o termo "${termoTitulo}" no título.`,
    )
  }

  // --- decide o tipo ---
  if (!url && !body) {
    throw new PayloadError(
      'url',
      'Informe um link ou um texto para publicar.',
    )
  }

  const postKind: 'link' | 'self' = url ? 'link' : 'self'
  // A API não aceita link e corpo juntos; o corpo vira comentário.
  const commentBody = url && body ? body : null

  if (commentBody && !intent.allowCommentFallback) {
    throw new PayloadError(
      'body',
      'A API do Reddit não permite link e texto na mesma publicação. ' +
        'Ative o comentário automático para enviar o texto logo após a publicação, ' +
        'ou remova um dos dois.',
    )
  }

  // --- restrições da comunidade ---
  if (postKind === 'link' && subreddit.submissionType === 'self') {
    throw new PayloadError(
      'url',
      `A comunidade r/${subreddit.name} aceita apenas publicações de texto.`,
    )
  }
  if (postKind === 'self' && subreddit.submissionType === 'link') {
    throw new PayloadError(
      'body',
      `A comunidade r/${subreddit.name} aceita apenas publicações com link.`,
    )
  }

  if (
    postKind === 'link' &&
    requirements.bodyRestrictionPolicy === 'required'
  ) {
    throw new PayloadError(
      'url',
      'Esta comunidade exige texto no corpo da publicação, o que é incompatível com um link.',
    )
  }
  if (postKind === 'self' && requirements.bodyRestrictionPolicy === 'notAllowed') {
    throw new PayloadError(
      'body',
      'Esta comunidade não permite texto no corpo da publicação.',
    )
  }

  // --- corpo (do post ou do comentário) ---
  const textoUsuario = body
  if (textoUsuario) {
    const termoCorpo = contemTermo(
      textoUsuario,
      requirements.bodyBlacklistedStrings,
    )
    if (termoCorpo) {
      throw new PayloadError(
        'body',
        `Esta comunidade não permite o termo "${termoCorpo}" no texto.`,
      )
    }
  }

  // --- link ---
  if (url) {
    const parsed = normalizarUrl(url)
    const host = parsed.hostname

    if (
      requirements.domainWhitelist.length > 0 &&
      !requirements.domainWhitelist.some((d) => dominioCasa(host, d))
    ) {
      throw new PayloadError(
        'url',
        `Esta comunidade só aceita links de: ${requirements.domainWhitelist.join(', ')}.`,
      )
    }
    if (requirements.domainBlacklist.some((d) => dominioCasa(host, d))) {
      throw new PayloadError(
        'url',
        'Esta comunidade não aceita links deste domínio.',
      )
    }
  }

  // --- flair ---
  const flairId = intent.flairId?.trim() || null
  if (requirements.isFlairRequired && !flairId) {
    throw new PayloadError('flairId', 'Esta comunidade exige um flair.')
  }

  return {
    postKind,
    title,
    url: postKind === 'link' ? url : null,
    body: postKind === 'self' ? body : null,
    flairId,
    nsfw: intent.nsfw,
    spoiler: intent.spoiler,
    commentBody,
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/scheduling/payload-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: construcao e validacao do payload de publicacao"
```

---

### Task 5: Criação atômica de post e comentário

**Files:**
- Create: `supabase/migrations/<timestamp>_create_scheduled_post_fn.sql`
- Test: `tests/db/create-scheduled-post.test.ts`

**Interfaces:**
- Produces: função `public.create_scheduled_post(p_post jsonb, p_comment jsonb)`

**Por que uma função SQL:** post e comentário precisam nascer juntos. Dois
inserts sequenciais da aplicação deixariam um post órfão se o segundo falhasse
— e o worker publicaria o post sem o comentário que o usuário pediu.

**`SECURITY INVOKER` de propósito:** a função roda com os privilégios do
usuário, então a RLS e as policies se aplicam normalmente aos inserts. Não há
necessidade de `service_role` para criar uma publicação, e usá-lo aqui
contornaria a proteção sem ganho nenhum.

- [ ] **Step 1: Criar a migration**

```powershell
npx supabase migration new create_scheduled_post_fn
```

- [ ] **Step 2: Escrever os testes falhando**

```ts
// tests/db/create-scheduled-post.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string
let subB: string

async function criarConta(ownerId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_cf_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function criarSub(ownerId: string, contaId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_cf_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    reddit_account_id: contaA,
    subreddit_id: subA,
    title: 'Título',
    url: 'https://exemplo.com/v',
    body: null,
    post_kind: 'link',
    flair_id: null,
    nsfw: false,
    spoiler: false,
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
    timezone: 'America/Sao_Paulo',
    status: 'scheduled',
    ...overrides,
  }
}

async function criar(
  token: string,
  p: Record<string, unknown>,
  c: Record<string, unknown> | null = null,
) {
  return userClient(token).rpc('create_scheduled_post', {
    p_post: p,
    p_comment: c,
  })
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`cf-a-${stamp}@teste.local`)
  userB = await createTestUser(`cf-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaB = await criarConta(userB.id, `b${stamp}`)
  subA = await criarSub(userA.id, contaA, `a${stamp}`)
  subB = await criarSub(userB.id, contaB, `b${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('create_scheduled_post', () => {
  it('cria o post sozinho quando não há comentário', async () => {
    const { data, error } = await criar(userA.accessToken, post())
    expect(error).toBeNull()
    expect(data).toBeTruthy()

    const { data: linhas } = await adminClient()
      .from('scheduled_posts')
      .select('id, owner_id, status')
      .eq('id', data as string)
    expect(linhas).toHaveLength(1)
    expect(linhas![0].owner_id).toBe(userA.id)
  })

  it('cria post e comentário juntos', async () => {
    const { data: postId, error } = await criar(userA.accessToken, post(), {
      body: 'Comentário automático',
      mode: 'immediate',
    })
    expect(error).toBeNull()

    const { data: comentarios } = await adminClient()
      .from('scheduled_comments')
      .select('id, body, reddit_account_id, owner_id')
      .eq('scheduled_post_id', postId as string)
    expect(comentarios).toHaveLength(1)
    expect(comentarios![0].body).toBe('Comentário automático')
    // A conta do comentário é herdada do post, não recebida do cliente.
    expect(comentarios![0].reddit_account_id).toBe(contaA)
    expect(comentarios![0].owner_id).toBe(userA.id)
  })

  it('ATOMICIDADE: comentário inválido não deixa post órfão', async () => {
    const antes = await adminClient()
      .from('scheduled_posts')
      .select('id')
      .eq('owner_id', userA.id)

    // mode delay sem delay_minutes viola a CHECK constraint.
    const { error } = await criar(userA.accessToken, post(), {
      body: 'Comentário',
      mode: 'delay',
    })
    expect(error).not.toBeNull()

    const depois = await adminClient()
      .from('scheduled_posts')
      .select('id')
      .eq('owner_id', userA.id)
    expect(depois.data!.length).toBe(antes.data!.length)
  })

  it('ATOMICIDADE: post inválido não cria comentário', async () => {
    const antes = await adminClient()
      .from('scheduled_comments')
      .select('id')
      .eq('owner_id', userA.id)

    const { error } = await criar(
      userA.accessToken,
      post({ title: '   ' }),
      { body: 'Comentário', mode: 'immediate' },
    )
    expect(error).not.toBeNull()

    const depois = await adminClient()
      .from('scheduled_comments')
      .select('id')
      .eq('owner_id', userA.id)
    expect(depois.data!.length).toBe(antes.data!.length)
  })

  it('IDOR: o owner vem da sessão, não do payload', async () => {
    // Mesmo mandando o owner de B, a linha nasce como de A.
    const { data: postId, error } = await criar(
      userA.accessToken,
      post({ owner_id: userB.id }),
    )
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('owner_id')
      .eq('id', postId as string)
      .single()
    expect(data!.owner_id).toBe(userA.id)
  })

  it('IDOR: A não agenda usando a conta de B', async () => {
    const { error } = await criar(
      userA.accessToken,
      post({ reddit_account_id: contaB, subreddit_id: subB }),
    )
    expect(error).not.toBeNull()
  })

  it('IDOR: A não agenda em comunidade de B', async () => {
    const { error } = await criar(
      userA.accessToken,
      post({ subreddit_id: subB }),
    )
    expect(error).not.toBeNull()
  })

  it('recusa status inicial fora de draft e scheduled', async () => {
    const { error } = await criar(
      userA.accessToken,
      post({ status: 'published' }),
    )
    expect(error).not.toBeNull()
  })

  it('aceita rascunho', async () => {
    const { error } = await criar(userA.accessToken, post({ status: 'draft' }))
    expect(error).toBeNull()
  })

  it('a função não é chamável por anon', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'create_scheduled_post'
           and has_function_privilege('anon', p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/db/create-scheduled-post.test.ts`
Expected: FAIL — a função não existe.

- [ ] **Step 4: Escrever a migration**

```sql
-- Cria publicação e comentário numa única transação.
--
-- Dois inserts sequenciais da aplicação deixariam um post órfão se o segundo
-- falhasse, e o worker publicaria sem o comentário que o usuário pediu.
--
-- SECURITY INVOKER: roda com os privilégios de quem chama, então RLS e
-- policies se aplicam normalmente. Criar publicação não precisa de
-- service_role, e usá-lo aqui contornaria a proteção sem ganho.
create or replace function public.create_scheduled_post(
  p_post jsonb,
  p_comment jsonb default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_post_id uuid;
  v_account uuid := (p_post ->> 'reddit_account_id')::uuid;
begin
  if v_owner is null then
    raise exception 'Sessão ausente.' using errcode = '42501';
  end if;

  -- owner_id vem SEMPRE da sessão, nunca do payload: é o que impede um
  -- cliente de agendar no nome de outro usuário.
  insert into public.scheduled_posts (
    owner_id, reddit_account_id, subreddit_id,
    title, url, body, post_kind, flair_id, flair_text,
    nsfw, spoiler, scheduled_at, timezone, status
  )
  values (
    v_owner,
    v_account,
    (p_post ->> 'subreddit_id')::uuid,
    p_post ->> 'title',
    nullif(p_post ->> 'url', ''),
    nullif(p_post ->> 'body', ''),
    p_post ->> 'post_kind',
    nullif(p_post ->> 'flair_id', ''),
    nullif(p_post ->> 'flair_text', ''),
    coalesce((p_post ->> 'nsfw')::boolean, false),
    coalesce((p_post ->> 'spoiler')::boolean, false),
    (p_post ->> 'scheduled_at')::timestamptz,
    coalesce(p_post ->> 'timezone', 'America/Sao_Paulo'),
    coalesce(p_post ->> 'status', 'scheduled')
  )
  returning id into v_post_id;

  if p_comment is not null then
    -- owner e conta são herdados do post, não recebidos do cliente: o
    -- comentário sai sempre pela mesma conta que publicou.
    insert into public.scheduled_comments (
      owner_id, scheduled_post_id, reddit_account_id,
      body, mode, delay_minutes, scheduled_at, status
    )
    values (
      v_owner,
      v_post_id,
      v_account,
      p_comment ->> 'body',
      p_comment ->> 'mode',
      (p_comment ->> 'delay_minutes')::integer,
      (p_comment ->> 'scheduled_at')::timestamptz,
      coalesce(p_comment ->> 'status', 'scheduled')
    );
  end if;

  return v_post_id;
end;
$$;

revoke execute on function public.create_scheduled_post(jsonb, jsonb)
  from public, anon;
grant execute on function public.create_scheduled_post(jsonb, jsonb)
  to authenticated, service_role;
```

- [ ] **Step 5: Aplicar, verificar e commitar**

```powershell
npx supabase db reset
npx vitest run tests/db/create-scheduled-post.test.ts
npx supabase db advisors --local --type security
npm run verify
```

```bash
git add -A
git commit -m "feat: criacao atomica de publicacao e comentario"
```

---

### Task 6: Server actions de criação

**Files:**
- Create: `src/app/(dashboard)/dashboard/new/schema.ts`
- Create: `src/app/(dashboard)/dashboard/new/actions.ts`
- Create: `src/lib/scheduling/create-post.ts`
- Test: `tests/scheduling/new-post-schema.test.ts`
- Test: `tests/db/create-post-action.test.ts`

**Interfaces:**
- Consumes: `assertAccountAccess`, `getRedditClient`, `getPostRequirements`, `buildPayload`, `toUtc`
- Produces:
  - `newPostSchema` (Zod)
  - `createScheduledPost(prev, formData): Promise<CreateState>`

**Ordem obrigatória**, e o motivo de cada passo:

1. `requireUser` — sessão;
2. Zod — forma dos dados;
3. `assertAccountAccess` — posse da conta;
4. confirmar que a comunidade pertence **àquela conta** (consulta com RLS);
5. `toUtc` — horário, recusando o que não existe;
6. `getPostRequirements` — regras reais; **falha aqui bloqueia**;
7. `buildPayload` — tradução e validação;
8. `create_scheduled_post` — gravação atômica.

- [ ] **Step 1: Escrever os testes de schema**

```ts
// tests/scheduling/new-post-schema.test.ts
import { describe, expect, it } from 'vitest'
import { newPostSchema } from '@/app/(dashboard)/dashboard/new/schema'

const base = {
  accountId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  subredditId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  title: 'Meu título',
  url: 'https://exemplo.com/v',
  body: '',
  flairId: '',
  nsfw: 'off',
  spoiler: 'off',
  date: '2026-09-01',
  time: '10:30',
  timeZone: 'America/Sao_Paulo',
  publishMode: 'schedule',
  addComment: 'off',
  commentBody: '',
  commentMode: 'immediate',
  commentDelayMinutes: '',
  allowCommentFallback: 'off',
}

describe('newPostSchema', () => {
  it('aceita um agendamento completo', () => {
    expect(newPostSchema.safeParse(base).success).toBe(true)
  })

  it('converte checkboxes de on/off para booleano', () => {
    const r = newPostSchema.parse({ ...base, nsfw: 'on', spoiler: 'on' })
    expect(r.nsfw).toBe(true)
    expect(r.spoiler).toBe(true)
  })

  it('trata checkbox ausente como falso', () => {
    const { nsfw, ...semNsfw } = base
    expect(newPostSchema.parse(semNsfw).nsfw).toBe(false)
  })

  it('recusa UUID inválido', () => {
    expect(newPostSchema.safeParse({ ...base, accountId: 'x' }).success).toBe(
      false,
    )
  })

  it('recusa título vazio', () => {
    expect(newPostSchema.safeParse({ ...base, title: '   ' }).success).toBe(
      false,
    )
  })

  it('recusa título acima de 300 caracteres', () => {
    expect(
      newPostSchema.safeParse({ ...base, title: 'x'.repeat(301) }).success,
    ).toBe(false)
  })

  it('recusa fuso fora da lista suportada', () => {
    expect(
      newPostSchema.safeParse({ ...base, timeZone: 'Marte/Olympus' }).success,
    ).toBe(false)
  })

  it('recusa data malformada', () => {
    expect(newPostSchema.safeParse({ ...base, date: '01/09/2026' }).success).toBe(
      false,
    )
  })

  it('recusa hora malformada', () => {
    expect(newPostSchema.safeParse({ ...base, time: '25:00' }).success).toBe(
      false,
    )
  })

  it('dispensa data e hora quando é publicação imediata', () => {
    const r = newPostSchema.safeParse({
      ...base,
      publishMode: 'now',
      date: '',
      time: '',
    })
    expect(r.success).toBe(true)
  })

  it('exige data e hora quando é agendamento', () => {
    expect(
      newPostSchema.safeParse({ ...base, date: '', time: '' }).success,
    ).toBe(false)
  })

  it('exige corpo do comentário quando o comentário está ativo', () => {
    expect(
      newPostSchema.safeParse({ ...base, addComment: 'on', commentBody: '' })
        .success,
    ).toBe(false)
  })

  it('exige minutos quando o modo do comentário é delay', () => {
    expect(
      newPostSchema.safeParse({
        ...base,
        addComment: 'on',
        commentBody: 'texto',
        commentMode: 'delay',
        commentDelayMinutes: '',
      }).success,
    ).toBe(false)
  })

  it('aceita comentário com atraso em minutos', () => {
    const r = newPostSchema.parse({
      ...base,
      addComment: 'on',
      commentBody: 'texto',
      commentMode: 'delay',
      commentDelayMinutes: '15',
    })
    expect(r.commentDelayMinutes).toBe(15)
  })
})
```

- [ ] **Step 2: Escrever os testes da action (com banco e API simulada)**

```ts
// tests/db/create-post-action.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { MockAgent } from 'undici'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { encryptSecret } from '@/lib/crypto/aes-gcm'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string
let subB: string
let agent: MockAgent

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

const pool = () => agent.get('https://oauth.reddit.com')

/**
 * O nome da comunidade muda a cada execução (leva timestamp), então o match é
 * pelo trecho estável do caminho.
 */
const reqPath = (p: string) => p.includes('/post_requirements')

/** Registra a resposta de post_requirements para a próxima chamada. */
function requisitos(body: Record<string, unknown>) {
  pool().intercept({ path: reqPath, method: 'GET' }).reply(200, body)
}

async function criarConta(ownerId: string, sufixo: string) {
  const { data } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_ca_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()

  await adminClient().from('reddit_account_secrets').insert({
    reddit_account_id: data!.id,
    owner_id: ownerId,
    access_token_enc: encryptSecret(
      'AT',
      `reddit_account_secrets:access_token:${data!.id}`,
    ),
    refresh_token_enc: encryptSecret(
      'RT',
      `reddit_account_secrets:refresh_token:${data!.id}`,
    ),
    access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })
  return data!.id as string
}

async function criarSub(ownerId: string, contaId: string, nome: string) {
  const { data } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_ca_${nome}`,
      name: nome,
      display_name: nome,
      url: `/r/${nome}/`,
      submission_type: 'any',
    })
    .select('id')
    .single()
  return data!.id as string
}

function form(campos: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(campos)) fd.set(k, v)
  return fd
}

function camposBase(overrides: Record<string, string> = {}) {
  return {
    accountId: contaA,
    subredditId: subA,
    title: 'Título de teste',
    url: 'https://exemplo.com/v',
    body: '',
    flairId: '',
    date: '2026-09-01',
    time: '10:30',
    timeZone: 'America/Sao_Paulo',
    publishMode: 'schedule',
    commentMode: 'immediate',
    ...overrides,
  }
}

async function chamar(campos: Record<string, string>) {
  const { createScheduledPost } = await import(
    '@/app/(dashboard)/dashboard/new/actions'
  )
  return createScheduledPost(
    { error: null, fieldError: null, postId: null },
    form(campos),
  )
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  const stamp = Date.now()
  userA = await createTestUser(`ca-a-${stamp}@teste.local`)
  userB = await createTestUser(`ca-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaB = await criarConta(userB.id, `b${stamp}`)
  subA = await criarSub(userA.id, contaA, `coma${stamp}`)
  subB = await criarSub(userB.id, contaB, `comb${stamp}`)
})

beforeEach(() => {
  process.env.REDDIT_CLIENT_ID = 'cid-suite-createpost'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
  sessao.id = userA.id
  clientToken.value = userA.accessToken
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('createScheduledPost', () => {
  it('agenda uma publicação de link', async () => {
    requisitos({})

    const r = await chamar(camposBase())
    expect(r.error).toBeNull()
    expect(r.postId).toBeTruthy()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('post_kind, url, body, scheduled_at, timezone, status')
      .eq('id', r.postId!)
      .single()
    expect(data!.post_kind).toBe('link')
    expect(data!.body).toBeNull()
    expect(data!.status).toBe('scheduled')
    // 10:30 em São Paulo é 13:30 UTC.
    expect(data!.scheduled_at).toContain('13:30')
  })

  it('link + texto cria post e comentário automático', async () => {
    requisitos({})

    const r = await chamar(
      camposBase({ body: 'texto do comentário', allowCommentFallback: 'on' }),
    )
    expect(r.error).toBeNull()

    const { data: post } = await adminClient()
      .from('scheduled_posts')
      .select('post_kind, body')
      .eq('id', r.postId!)
      .single()
    expect(post!.post_kind).toBe('link')
    expect(post!.body).toBeNull()

    const { data: comentarios } = await adminClient()
      .from('scheduled_comments')
      .select('body, mode')
      .eq('scheduled_post_id', r.postId!)
    expect(comentarios).toHaveLength(1)
    expect(comentarios![0].body).toBe('texto do comentário')
  })

  it('BLOQUEIO: falha ao ler requisitos impede o agendamento', async () => {
    // Herdado do Plano 3: indisponibilidade não vira validação permissiva.
    pool().intercept({ path: reqPath, method: 'GET' }).reply(403, {})

    const antes = await adminClient()
      .from('scheduled_posts')
      .select('id')
      .eq('owner_id', userA.id)

    const r = await chamar(camposBase())
    expect(r.error).toMatch(/não foi possível verificar/i)

    const depois = await adminClient()
      .from('scheduled_posts')
      .select('id')
      .eq('owner_id', userA.id)
    expect(depois.data!.length).toBe(antes.data!.length)
  })

  it('respeita flair obrigatório informado pela comunidade', async () => {
    requisitos({ is_flair_required: true })

    const r = await chamar(camposBase())
    expect(r.error).toMatch(/flair/i)
    expect(r.fieldError).toBe('flairId')
  })

  it('IDOR: A não agenda com a conta de B', async () => {
    const r = await chamar(camposBase({ accountId: contaB, subredditId: subB }))
    expect(r.error).toBeTruthy()
    expect(r.postId).toBeNull()
  })

  it('IDOR: A não agenda em comunidade de B', async () => {
    const r = await chamar(camposBase({ subredditId: subB }))
    expect(r.error).toBeTruthy()
    expect(r.postId).toBeNull()
  })

  it('recusa comunidade que não pertence à conta escolhida', async () => {
    const outraConta = await criarConta(userA.id, `o${Date.now()}`)
    const r = await chamar(camposBase({ accountId: outraConta }))
    expect(r.error).toBeTruthy()
  })

  it('recusa horário inexistente por DST', async () => {
    const r = await chamar(
      camposBase({
        date: '2026-03-08',
        time: '02:30',
        timeZone: 'America/New_York',
      }),
    )
    expect(r.error).toMatch(/não existe/i)
    expect(r.postId).toBeNull()
  })

  it('publicar agora agenda para o instante atual', async () => {
    requisitos({})

    const antes = Date.now()
    const r = await chamar(camposBase({ publishMode: 'now', date: '', time: '' }))
    expect(r.error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('scheduled_at')
      .eq('id', r.postId!)
      .single()
    const quando = new Date(data!.scheduled_at).getTime()
    expect(quando).toBeGreaterThanOrEqual(antes - 5000)
    expect(quando).toBeLessThanOrEqual(Date.now() + 5000)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/scheduling/new-post-schema.test.ts tests/db/create-post-action.test.ts`
Expected: FAIL

- [ ] **Step 4: Implementar o schema**

```ts
// src/app/(dashboard)/dashboard/new/schema.ts
import { z } from 'zod'
import { SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

/** Checkbox de formulário chega como 'on' ou não chega. */
const checkbox = z
  .union([z.literal('on'), z.literal('off'), z.undefined(), z.null()])
  .transform((v) => v === 'on')

export const newPostSchema = z
  .object({
    accountId: z.uuid(),
    subredditId: z.uuid(),
    title: z.string().trim().min(1, 'Informe o título.').max(300),
    url: z.string().trim().default(''),
    body: z.string().trim().default(''),
    flairId: z.string().trim().default(''),
    nsfw: checkbox,
    spoiler: checkbox,
    allowCommentFallback: checkbox,

    date: z.string().trim().default(''),
    time: z.string().trim().default(''),
    timeZone: z.enum(SUPPORTED_TIME_ZONES),
    publishMode: z.enum(['now', 'schedule']),

    addComment: checkbox,
    commentBody: z.string().trim().default(''),
    commentMode: z.enum(['immediate', 'delay', 'absolute']),
    commentDelayMinutes: z
      .string()
      .trim()
      .default('')
      .transform((v) => (v === '' ? null : Number(v)))
      .refine((v) => v === null || (Number.isInteger(v) && v >= 0), {
        message: 'Informe os minutos como número inteiro.',
      }),
    commentDate: z.string().trim().default(''),
    commentTime: z.string().trim().default(''),
  })
  .superRefine((v, ctx) => {
    if (v.publishMode === 'schedule') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) {
        ctx.addIssue({
          code: 'custom',
          path: ['date'],
          message: 'Informe a data da publicação.',
        })
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) {
        ctx.addIssue({
          code: 'custom',
          path: ['time'],
          message: 'Informe o horário da publicação.',
        })
      }
    }

    if (v.addComment) {
      if (v.commentBody.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['commentBody'],
          message: 'Informe o texto do comentário.',
        })
      }
      if (v.commentMode === 'delay' && v.commentDelayMinutes === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['commentDelayMinutes'],
          message: 'Informe em quantos minutos o comentário deve ser enviado.',
        })
      }
      if (
        v.commentMode === 'absolute' &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(v.commentDate) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.commentTime))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['commentDate'],
          message: 'Informe data e horário do comentário.',
        })
      }
    }
  })

export type NewPostInput = z.infer<typeof newPostSchema>

export type CreateState = {
  error: string | null
  /** Campo a destacar no formulário, quando o erro for de um campo. */
  fieldError: string | null
  postId: string | null
}
```

- [ ] **Step 5: Implementar a criação**

```ts
// src/lib/scheduling/create-post.ts
import 'server-only'
import type { Dispatcher } from 'undici'
import { assertAccountAccess } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { getPostRequirements } from '@/lib/reddit/requirements'
import { buildPayload, PayloadError } from './payload-builder'
import { toUtc } from './timezone'
import type { NewPostInput } from '@/app/(dashboard)/dashboard/new/schema'

export type CreateResult = {
  postId: string
  ambiguousTime: boolean
}

export class SubredditMismatchError extends Error {
  constructor() {
    super('A comunidade escolhida não pertence a esta conta.')
    this.name = 'SubredditMismatchError'
  }
}

/**
 * Cria uma publicação agendada.
 *
 * A ordem importa: posse antes de qualquer leitura de segredo, requisitos
 * antes de validar, e gravação atômica no fim. Falha ao ler requisitos
 * interrompe — nunca vira validação permissiva.
 */
export async function createPost(
  input: NewPostInput,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<CreateResult> {
  const account = await assertAccountAccess(input.accountId)

  const supabase = await createServerSupabase()
  const { data: subreddit } = await supabase
    .from('subreddits')
    .select('id, name, submission_type, link_flair_enabled, reddit_account_id, status')
    .eq('id', input.subredditId)
    .maybeSingle()

  // A RLS já garante que a comunidade é do usuário; falta garantir que é
  // desta conta. As FKs compostas barrariam na gravação, mas a mensagem aqui
  // é muito melhor.
  if (!subreddit || subreddit.reddit_account_id !== account.id) {
    throw new SubredditMismatchError()
  }

  // --- horário ---
  const agendamento =
    input.publishMode === 'now'
      ? { utc: new Date(), ambiguous: false }
      : toUtc({
          date: input.date,
          time: input.time,
          timeZone: input.timeZone,
        })

  // --- requisitos reais da comunidade ---
  const client = await getRedditClient(account, opts)
  const requirements = await getPostRequirements(client, subreddit.name)

  // --- payload ---
  const payload = buildPayload(
    {
      title: input.title,
      url: input.url || undefined,
      body: input.body || undefined,
      flairId: input.flairId || undefined,
      nsfw: input.nsfw,
      spoiler: input.spoiler,
      allowCommentFallback: input.allowCommentFallback || input.addComment,
    },
    requirements,
    {
      name: subreddit.name,
      submissionType:
        (subreddit.submission_type as 'any' | 'link' | 'self') ?? 'any',
      linkFlairEnabled: Boolean(subreddit.link_flair_enabled),
    },
  )

  // --- comentário ---
  // Duas origens possíveis: o texto redirecionado pelo payload builder, ou um
  // comentário escrito de propósito pelo usuário. O explícito vence.
  const corpoComentario = input.addComment
    ? input.commentBody
    : payload.commentBody

  let comentario: Record<string, unknown> | null = null
  if (corpoComentario) {
    const modo = input.addComment ? input.commentMode : 'immediate'
    comentario = {
      body: corpoComentario,
      mode: modo,
      delay_minutes: modo === 'delay' ? input.commentDelayMinutes : null,
      scheduled_at:
        modo === 'absolute'
          ? toUtc({
              date: input.commentDate,
              time: input.commentTime,
              timeZone: input.timeZone,
            }).utc.toISOString()
          : null,
    }
  }

  // --- gravação atômica ---
  const { data, error } = await supabase.rpc('create_scheduled_post', {
    p_post: {
      reddit_account_id: account.id,
      subreddit_id: subreddit.id,
      title: payload.title,
      url: payload.url,
      body: payload.body,
      post_kind: payload.postKind,
      flair_id: payload.flairId,
      nsfw: payload.nsfw,
      spoiler: payload.spoiler,
      scheduled_at: agendamento.utc.toISOString(),
      timezone: input.timeZone,
      status: 'scheduled',
    },
    p_comment: comentario,
  })

  if (error || !data) {
    throw error ?? new Error('Falha ao gravar a publicação.')
  }

  return { postId: data as string, ambiguousTime: agendamento.ambiguous }
}

export { PayloadError }
```

- [ ] **Step 6: Implementar a server action**

```ts
// src/app/(dashboard)/dashboard/new/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { ForbiddenError } from '@/lib/auth/ownership'
import { RedditError } from '@/lib/reddit/errors'
import { createPost, SubredditMismatchError } from '@/lib/scheduling/create-post'
import { PayloadError } from '@/lib/scheduling/payload-builder'
import { NonexistentTimeError } from '@/lib/scheduling/timezone'
import { newPostSchema, type CreateState } from './schema'

export async function createScheduledPost(
  _prev: CreateState,
  formData: FormData,
): Promise<CreateState> {
  const bruto = Object.fromEntries(formData.entries())
  const parsed = newPostSchema.safeParse(bruto)

  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: issue.message,
      fieldError: String(issue.path[0] ?? ''),
      postId: null,
    }
  }

  try {
    const { postId } = await createPost(parsed.data)
    revalidatePath('/dashboard/queue')
    revalidatePath('/dashboard/calendar')
    return { error: null, fieldError: null, postId }
  } catch (e) {
    if (e instanceof PayloadError) {
      return { error: e.userMessage, fieldError: e.field, postId: null }
    }
    if (e instanceof NonexistentTimeError) {
      return { error: e.message, fieldError: 'time', postId: null }
    }
    if (e instanceof SubredditMismatchError) {
      return { error: e.message, fieldError: 'subredditId', postId: null }
    }
    if (e instanceof ForbiddenError) {
      return { error: 'Conta não encontrada.', fieldError: 'accountId', postId: null }
    }
    if (e instanceof RedditError) {
      // Inclui REQUIREMENTS_UNAVAILABLE, orçamento e conta desconectada.
      return { error: e.userMessage, fieldError: null, postId: null }
    }
    return {
      error: 'Não foi possível agendar a publicação agora.',
      fieldError: null,
      postId: null,
    }
  }
}
```

- [ ] **Step 7: Rodar, verificar e commitar**

```powershell
npx vitest run tests/scheduling tests/db/create-post-action.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: server action de criacao de publicacao agendada"
```

---

### Task 7: Edição, reagendamento e cancelamento

**Files:**
- Create: `src/app/(dashboard)/dashboard/queue/actions.ts`
- Create: `src/lib/scheduling/update-post.ts`
- Test: `tests/db/update-post-action.test.ts`

**Interfaces:**
- Produces:
  - `reschedulePost(prev, formData)` — muda apenas data, hora e fuso
  - `cancelPost(prev, formData)`
  - `EDITABLE_STATUSES` — `['draft', 'scheduled']`

**Regra:** edição e cancelamento só valem em `draft` e `scheduled`. O trigger
da Task 1 já recusa o resto no banco; a action verifica antes para dar
mensagem decente em vez de erro de constraint.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/db/update-post-action.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let subA: string

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

async function criarPost(status = 'scheduled') {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: contaA,
      subreddit_id: subA,
      title: 'Post para editar',
      url: 'https://exemplo.com/v',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
      status,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

function form(campos: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(campos)) fd.set(k, v)
  return fd
}

async function reagendar(campos: Record<string, string>) {
  const { reschedulePost } = await import(
    '@/app/(dashboard)/dashboard/queue/actions'
  )
  return reschedulePost({ error: null, ok: false }, form(campos))
}

async function cancelar(postId: string) {
  const { cancelPost } = await import('@/app/(dashboard)/dashboard/queue/actions')
  return cancelPost({ error: null, ok: false }, form({ postId }))
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`up-a-${stamp}@teste.local`)
  userB = await createTestUser(`up-b-${stamp}@teste.local`)

  const { data: conta } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_up_${stamp}`,
      username: 'conta_up',
    })
    .select('id')
    .single()
  contaA = conta!.id as string

  const { data: sub } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: userA.id,
      reddit_account_id: contaA,
      subreddit_fullname: `t5_up_${stamp}`,
      name: 'com_up',
      display_name: 'Comunidade',
      url: '/r/com_up/',
    })
    .select('id')
    .single()
  subA = sub!.id as string
})

beforeEach(() => {
  sessao.id = userA.id
  clientToken.value = userA.accessToken
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('reagendamento', () => {
  it('altera data e hora de um post agendado', async () => {
    const id = await criarPost()
    const r = await reagendar({
      postId: id,
      date: '2026-10-05',
      time: '08:15',
      timeZone: 'America/Sao_Paulo',
    })
    expect(r.error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('scheduled_at')
      .eq('id', id)
      .single()
    // 08:15 em São Paulo é 11:15 UTC.
    expect(data!.scheduled_at).toContain('11:15')
  })

  it('recusa horário inexistente por DST', async () => {
    const id = await criarPost()
    const r = await reagendar({
      postId: id,
      date: '2026-03-08',
      time: '02:30',
      timeZone: 'America/New_York',
    })
    expect(r.error).toMatch(/não existe/i)
  })

  it.each(['processing', 'published', 'failed', 'needs_review', 'cancelled'])(
    'recusa reagendar post em %s',
    async (status) => {
      const id = await criarPost()
      await adminClient()
        .from('scheduled_posts')
        .update({ status })
        .eq('id', id)

      const r = await reagendar({
        postId: id,
        date: '2026-10-05',
        time: '08:15',
        timeZone: 'America/Sao_Paulo',
      })
      expect(r.error).toBeTruthy()
    },
  )

  it('IDOR: B não reagenda post de A', async () => {
    const id = await criarPost()
    sessao.id = userB.id
    clientToken.value = userB.accessToken

    const r = await reagendar({
      postId: id,
      date: '2026-10-05',
      time: '08:15',
      timeZone: 'America/Sao_Paulo',
    })
    expect(r.error).toBeTruthy()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('scheduled_at')
      .eq('id', id)
      .single()
    expect(data!.scheduled_at).not.toContain('11:15')
  })
})

describe('cancelamento', () => {
  it('cancela um post agendado', async () => {
    const id = await criarPost()
    const r = await cancelar(id)
    expect(r.error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('cancelled')
  })

  it('cancela também os comentários pendentes', async () => {
    const id = await criarPost()
    await adminClient().from('scheduled_comments').insert({
      owner_id: userA.id,
      scheduled_post_id: id,
      reddit_account_id: contaA,
      body: 'comentário',
      mode: 'immediate',
    })

    await cancelar(id)

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('status')
      .eq('scheduled_post_id', id)
    expect(data!.every((c) => c.status === 'cancelled')).toBe(true)
  })

  it.each(['processing', 'published', 'needs_review'])(
    'recusa cancelar post em %s',
    async (status) => {
      const id = await criarPost()
      await adminClient().from('scheduled_posts').update({ status }).eq('id', id)

      const r = await cancelar(id)
      expect(r.error).toBeTruthy()
    },
  )

  it('IDOR: B não cancela post de A', async () => {
    const id = await criarPost()
    sessao.id = userB.id
    clientToken.value = userB.accessToken

    const r = await cancelar(id)
    expect(r.error).toBeTruthy()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('scheduled')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/db/update-post-action.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar**

```ts
// src/lib/scheduling/update-post.ts
import 'server-only'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/require-user'
import { toUtc } from './timezone'

/** Estados em que o usuário ainda manda no agendamento. */
export const EDITABLE_STATUSES = ['draft', 'scheduled'] as const

export class NotEditableError extends Error {
  constructor(status: string) {
    const rotulos: Record<string, string> = {
      processing: 'está sendo publicada agora',
      published: 'já foi publicada',
      failed: 'falhou e precisa ser reagendada pelo histórico',
      cancelled: 'foi cancelada',
      needs_review: 'aguarda revisão manual',
    }
    super(
      `Não é possível alterar esta publicação: ela ${
        rotulos[status] ?? 'não está mais editável'
      }.`,
    )
    this.name = 'NotEditableError'
  }
}

export class PostNotFoundError extends Error {
  constructor() {
    super('Publicação não encontrada.')
    this.name = 'PostNotFoundError'
  }
}

async function carregarEditavel(postId: string) {
  const user = await requireUser()
  const supabase = await createServerSupabase()

  const { data } = await supabase
    .from('scheduled_posts')
    .select('id, owner_id, status')
    .eq('id', postId)
    .maybeSingle()

  if (!data) throw new PostNotFoundError()
  // Redundante com a RLS, e de propósito.
  if (data.owner_id !== user.id) throw new PostNotFoundError()
  if (!EDITABLE_STATUSES.includes(data.status as 'draft' | 'scheduled')) {
    throw new NotEditableError(data.status)
  }

  return { supabase, post: data }
}

export async function reschedule(
  postId: string,
  when: { date: string; time: string; timeZone: string },
): Promise<{ ambiguous: boolean }> {
  const { supabase } = await carregarEditavel(postId)
  const { utc, ambiguous } = toUtc(when)

  const { error } = await supabase
    .from('scheduled_posts')
    .update({
      scheduled_at: utc.toISOString(),
      timezone: when.timeZone,
    })
    .eq('id', postId)

  if (error) throw error
  return { ambiguous }
}

export async function cancel(postId: string): Promise<void> {
  const { supabase } = await carregarEditavel(postId)

  const { error } = await supabase
    .from('scheduled_posts')
    .update({ status: 'cancelled' })
    .eq('id', postId)
  if (error) throw error

  // Comentário sem post não faz sentido. Só os que ainda não executaram.
  await supabase
    .from('scheduled_comments')
    .update({ status: 'cancelled' })
    .eq('scheduled_post_id', postId)
    .in('status', ['draft', 'scheduled'])
}
```

```ts
// src/app/(dashboard)/dashboard/queue/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  NonexistentTimeError,
  SUPPORTED_TIME_ZONES,
} from '@/lib/scheduling/timezone'
import {
  cancel,
  NotEditableError,
  PostNotFoundError,
  reschedule,
} from '@/lib/scheduling/update-post'

export type QueueState = { error: string | null; ok: boolean }

const rescheduleSchema = z.object({
  postId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data.'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Informe o horário.'),
  timeZone: z.enum(SUPPORTED_TIME_ZONES),
})

function traduzir(e: unknown): string {
  if (e instanceof NonexistentTimeError) return e.message
  if (e instanceof NotEditableError) return e.message
  if (e instanceof PostNotFoundError) return e.message
  return 'Não foi possível concluir a operação agora.'
}

export async function reschedulePost(
  _prev: QueueState,
  formData: FormData,
): Promise<QueueState> {
  const parsed = rescheduleSchema.safeParse(
    Object.fromEntries(formData.entries()),
  )
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, ok: false }
  }

  try {
    await reschedule(parsed.data.postId, {
      date: parsed.data.date,
      time: parsed.data.time,
      timeZone: parsed.data.timeZone,
    })
  } catch (e) {
    return { error: traduzir(e), ok: false }
  }

  revalidatePath('/dashboard/queue')
  revalidatePath('/dashboard/calendar')
  return { error: null, ok: true }
}

export async function cancelPost(
  _prev: QueueState,
  formData: FormData,
): Promise<QueueState> {
  const parsed = z
    .object({ postId: z.uuid() })
    .safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: 'Publicação inválida.', ok: false }
  }

  try {
    await cancel(parsed.data.postId)
  } catch (e) {
    return { error: traduzir(e), ok: false }
  }

  revalidatePath('/dashboard/queue')
  revalidatePath('/dashboard/calendar')
  return { error: null, ok: true }
}
```

- [ ] **Step 4: Rodar, verificar e commitar**

```powershell
npx vitest run tests/db/update-post-action.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: reagendamento e cancelamento nos estados permitidos"
```

---

### Task 8: Formulário de Nova Publicação

**Files:**
- Create: `src/app/(dashboard)/dashboard/new/page.tsx`
- Create: `src/components/posts/new-post-form.tsx`
- Create: `src/app/api/reddit/flairs/route.ts`
- Test: `tests/posts/form-security.test.ts`

**Interfaces:**
- Consumes: `createScheduledPost`, `SUPPORTED_TIME_ZONES`
- Produces: rota `/dashboard/new`; endpoint interno de flairs

**Comportamento que a UI precisa deixar explícito:**

1. o seletor de comunidades mostra **apenas** as da conta escolhida — trocar a conta limpa a comunidade;
2. quando há link **e** texto, um aviso explica que a API não aceita os dois e que o texto irá como comentário — com caixa de confirmação;
3. flairs são carregados sob demanda ao escolher a comunidade, e a falha aparece como "não foi possível carregar", nunca como "esta comunidade não tem flair";
4. o fuso padrão é `America/Sao_Paulo`;
5. horário ambíguo por DST gera aviso, não bloqueio.

- [ ] **Step 1: Escrever o teste de segurança do formulário**

```ts
// tests/posts/form-security.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync(
  'src/app/(dashboard)/dashboard/new/page.tsx',
  'utf8',
)
const form = readFileSync('src/components/posts/new-post-form.tsx', 'utf8')
const flairs = readFileSync('src/app/api/reddit/flairs/route.ts', 'utf8')
const actions = readFileSync(
  'src/app/(dashboard)/dashboard/new/actions.ts',
  'utf8',
)

describe('página de nova publicação', () => {
  it('lê dados com o client do usuário', () => {
    expect(page).toContain('createServerSupabase')
    expect(page).not.toContain('createAdminSupabase')
  })

  it('oferece apenas comunidades ativas', () => {
    expect(page).toContain("'active'")
  })

  it('não seleciona colunas sensíveis', () => {
    for (const proibido of ['access_token', 'refresh_token', 'proxy_password']) {
      expect(page).not.toContain(proibido)
    }
  })
})

describe('formulário', () => {
  it('filtra comunidades pela conta escolhida', () => {
    expect(form).toMatch(/reddit_account_id|accountId/)
  })

  it('explica a limitação de link + texto', () => {
    expect(form).toMatch(/coment/i)
    expect(form).toMatch(/não permite|nao permite|não aceita/i)
  })

  it('tem confirmação explícita para o comentário automático', () => {
    expect(form).toContain('allowCommentFallback')
  })

  it('usa o fuso padrão da spec', () => {
    expect(form).toContain('America/Sao_Paulo')
  })

  it('oferece publicar agora e agendar', () => {
    expect(form).toContain('publishMode')
    expect(form).toMatch(/Publicar agora/i)
    expect(form).toMatch(/Programar/i)
  })
})

describe('endpoint de flairs', () => {
  it('roda no runtime Node', () => {
    expect(flairs).toMatch(/export const runtime = 'nodejs'/)
  })

  it('verifica a posse da conta antes de consultar', () => {
    expect(flairs).toContain('assertAccountAccess')
  })

  it('distingue indisponibilidade de ausência de flair', () => {
    expect(flairs).toContain('FLAIRS_UNAVAILABLE')
  })
})

describe('action de criação', () => {
  it('devolve o campo responsável pelo erro', () => {
    expect(actions).toContain('fieldError')
  })

  it('trata erro de requisitos indisponíveis', () => {
    expect(actions).toContain('RedditError')
  })
})
```

- [ ] **Step 2: Implementar o endpoint de flairs**

```ts
// src/app/api/reddit/flairs/route.ts
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'
import { assertAccountAccess, ForbiddenError } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { listLinkFlairs } from '@/lib/reddit/flairs'
import { RedditError } from '@/lib/reddit/errors'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    await requireUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ erro: 'Sessão ausente.' }, { status: 401 })
    }
    throw e
  }

  const accountId = request.nextUrl.searchParams.get('accountId')
  const subredditId = request.nextUrl.searchParams.get('subredditId')
  if (!accountId || !subredditId) {
    return NextResponse.json({ erro: 'Parâmetros ausentes.' }, { status: 400 })
  }

  try {
    const account = await assertAccountAccess(accountId)

    const supabase = await createServerSupabase()
    const { data: subreddit } = await supabase
      .from('subreddits')
      .select('name, reddit_account_id')
      .eq('id', subredditId)
      .maybeSingle()

    if (!subreddit || subreddit.reddit_account_id !== account.id) {
      return NextResponse.json(
        { erro: 'Comunidade não encontrada para esta conta.' },
        { status: 404 },
      )
    }

    const client = await getRedditClient(account)
    const flairs = await listLinkFlairs(client, subreddit.name)

    // Lista vazia aqui significa mesmo "não há flair cadastrado": qualquer
    // falha de leitura teria lançado.
    return NextResponse.json({ flairs })
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ erro: 'Conta não encontrada.' }, { status: 404 })
    }
    if (e instanceof RedditError) {
      const indisponivel = e.code === 'FLAIRS_UNAVAILABLE'
      return NextResponse.json(
        { erro: e.userMessage, indisponivel },
        { status: indisponivel ? 409 : 502 },
      )
    }
    return NextResponse.json(
      { erro: 'Não foi possível carregar os flairs.' },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 3: Implementar a página**

```tsx
// src/app/(dashboard)/dashboard/new/page.tsx
import { createServerSupabase } from '@/lib/supabase/server'
import { NewPostForm } from '@/components/posts/new-post-form'

export default async function NewPostPage() {
  const supabase = await createServerSupabase()

  const { data: contas } = await supabase
    .from('reddit_accounts')
    .select('id, username, status')
    .eq('status', 'connected')
    .order('username')

  const { data: comunidades } = await supabase
    .from('subreddits')
    .select('id, name, reddit_account_id, submission_type, link_flair_enabled')
    .eq('status', 'active')
    .order('name')

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Nova publicação
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Agende uma publicação em uma das comunidades que você modera.
      </p>

      {(contas ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Conecte uma conta Reddit e sincronize as comunidades antes de agendar.
        </p>
      ) : (
        <NewPostForm
          accounts={contas ?? []}
          communities={comunidades ?? []}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Implementar o formulário**

O componente é longo; a estrutura obrigatória é esta, e o restante segue o
estilo já usado em `network-form.tsx`:

```tsx
// src/components/posts/new-post-form.tsx
'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import { createScheduledPost } from '@/app/(dashboard)/dashboard/new/actions'
import type { CreateState } from '@/app/(dashboard)/dashboard/new/schema'
import { SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

const initial: CreateState = { error: null, fieldError: null, postId: null }

type Account = { id: string; username: string; status: string }
type Community = {
  id: string
  name: string
  reddit_account_id: string
  submission_type: string | null
  link_flair_enabled: boolean
}
type Flair = { id: string; text: string; modOnly: boolean }

const field =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100'
const label = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300'

export function NewPostForm({
  accounts,
  communities,
}: {
  accounts: Account[]
  communities: Community[]
}) {
  const [state, action, pending] = useActionState(createScheduledPost, initial)

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [subredditId, setSubredditId] = useState('')
  const [url, setUrl] = useState('')
  const [body, setBody] = useState('')
  const [addComment, setAddComment] = useState(false)
  const [commentMode, setCommentMode] = useState('immediate')
  const [publishMode, setPublishMode] = useState('schedule')

  const [flairs, setFlairs] = useState<Flair[]>([])
  const [flairErro, setFlairErro] = useState<string | null>(null)

  // Só as comunidades da conta escolhida.
  const doAccount = useMemo(
    () => communities.filter((c) => c.reddit_account_id === accountId),
    [communities, accountId],
  )

  // Trocar de conta invalida a comunidade escolhida.
  useEffect(() => {
    setSubredditId('')
    setFlairs([])
    setFlairErro(null)
  }, [accountId])

  // Flairs sob demanda.
  useEffect(() => {
    if (!accountId || !subredditId) return
    let cancelado = false

    setFlairErro(null)
    fetch(
      `/api/reddit/flairs?accountId=${accountId}&subredditId=${subredditId}`,
    )
      .then(async (r) => {
        const json = await r.json()
        if (cancelado) return
        if (!r.ok) {
          // Nunca dizemos "não tem flair" quando não conseguimos verificar.
          setFlairs([])
          setFlairErro(json.erro ?? 'Não foi possível carregar os flairs.')
          return
        }
        setFlairs(json.flairs ?? [])
      })
      .catch(() => {
        if (!cancelado) setFlairErro('Não foi possível carregar os flairs.')
      })

    return () => {
      cancelado = true
    }
  }, [accountId, subredditId])

  const precisaComentario = url.trim() !== '' && body.trim() !== ''

  return (
    <form action={action} className="mt-6 space-y-5">
      {/* Conta */}
      <div>
        <label htmlFor="accountId" className={label}>
          Conta Reddit
        </label>
        <select
          id="accountId"
          name="accountId"
          required
          className={field}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              u/{a.username}
            </option>
          ))}
        </select>
      </div>

      {/* Comunidade — apenas as da conta escolhida */}
      <div>
        <label htmlFor="subredditId" className={label}>
          Comunidade
        </label>
        <select
          id="subredditId"
          name="subredditId"
          required
          className={field}
          value={subredditId}
          onChange={(e) => setSubredditId(e.target.value)}
        >
          <option value="">Selecione…</option>
          {doAccount.map((c) => (
            <option key={c.id} value={c.id}>
              r/{c.name}
            </option>
          ))}
        </select>
        {doAccount.length === 0 && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            Esta conta ainda não tem comunidades sincronizadas.
          </p>
        )}
      </div>

      {/* Título */}
      <div>
        <label htmlFor="title" className={label}>
          Título
        </label>
        <input
          id="title"
          name="title"
          required
          maxLength={300}
          className={field}
        />
      </div>

      {/* Link */}
      <div>
        <label htmlFor="url" className={label}>
          Link
        </label>
        <input
          id="url"
          name="url"
          type="url"
          placeholder="https://…"
          className={field}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      {/* Texto */}
      <div>
        <label htmlFor="body" className={label}>
          Texto do post
        </label>
        <textarea
          id="body"
          name="body"
          rows={8}
          className={field}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {/* Aviso da limitação da API */}
      {precisaComentario && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            A API do Reddit não permite link e texto na mesma publicação.
            O texto pode ser enviado como comentário automático logo após a
            publicação.
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm text-amber-900 dark:text-amber-200">
            <input type="checkbox" name="allowCommentFallback" />
            Enviar o texto como comentário automático
          </label>
        </div>
      )}

      {/* Flair */}
      <div>
        <label htmlFor="flairId" className={label}>
          Flair
        </label>
        <select id="flairId" name="flairId" className={field}>
          <option value="">Sem flair</option>
          {flairs
            .filter((f) => !f.modOnly)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.text}
              </option>
            ))}
        </select>
        {flairErro && (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {flairErro}
          </p>
        )}
      </div>

      {/* Marcadores */}
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input type="checkbox" name="nsfw" />
          Conteúdo adulto (NSFW)
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input type="checkbox" name="spoiler" />
          Spoiler
        </label>
      </div>

      {/* Fuso */}
      <div>
        <label htmlFor="timeZone" className={label}>
          Fuso horário
        </label>
        <select
          id="timeZone"
          name="timeZone"
          className={field}
          defaultValue="America/Sao_Paulo"
        >
          {SUPPORTED_TIME_ZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      {/* Publicar agora vs. programar */}
      <fieldset>
        <legend className={label}>Publicação</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="publishMode"
            value="now"
            checked={publishMode === 'now'}
            onChange={() => setPublishMode('now')}
          />
          Publicar agora
        </label>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="publishMode"
            value="schedule"
            checked={publishMode === 'schedule'}
            onChange={() => setPublishMode('schedule')}
          />
          Programar
        </label>
      </fieldset>

      {/* Data e hora — só fazem sentido no modo programar */}
      {publishMode === 'schedule' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="date" className={label}>
              Data
            </label>
            <input id="date" name="date" type="date" className={field} />
          </div>
          <div>
            <label htmlFor="time" className={label}>
              Horário
            </label>
            <input id="time" name="time" type="time" className={field} />
          </div>
        </div>
      )}

      {/* Comentário automático */}
      <div className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            name="addComment"
            checked={addComment}
            onChange={(e) => setAddComment(e.target.checked)}
          />
          Adicionar comentário automático
        </label>

        {addComment && (
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="commentBody" className={label}>
                Texto do comentário
              </label>
              <textarea
                id="commentBody"
                name="commentBody"
                rows={4}
                className={field}
              />
            </div>

            <div>
              <label htmlFor="commentMode" className={label}>
                Quando comentar
              </label>
              <select
                id="commentMode"
                name="commentMode"
                className={field}
                value={commentMode}
                onChange={(e) => setCommentMode(e.target.value)}
              >
                <option value="immediate">
                  Imediatamente após a publicação
                </option>
                <option value="delay">Minutos depois da publicação</option>
                <option value="absolute">Em um horário específico</option>
              </select>
            </div>

            {commentMode === 'delay' && (
              <div>
                <label htmlFor="commentDelayMinutes" className={label}>
                  Minutos após a publicação
                </label>
                <input
                  id="commentDelayMinutes"
                  name="commentDelayMinutes"
                  type="number"
                  min={0}
                  className={field}
                />
              </div>
            )}

            {commentMode === 'absolute' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="commentDate" className={label}>
                    Data do comentário
                  </label>
                  <input
                    id="commentDate"
                    name="commentDate"
                    type="date"
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="commentTime" className={label}>
                    Horário do comentário
                  </label>
                  <input
                    id="commentTime"
                    name="commentTime"
                    type="time"
                    className={field}
                  />
                </div>
              </div>
            )}

            <p className="text-xs text-neutral-500">
              O comentário só é enviado depois que a publicação for concluída
              com sucesso, sempre pela mesma conta.
            </p>
          </div>
        )}
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.postId && (
        <p className="text-sm text-green-700 dark:text-green-400">
          Publicação agendada.
        </p>
      )}

      <button
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending
          ? 'Salvando…'
          : publishMode === 'now'
            ? 'Publicar agora'
            : 'Programar publicação'}
      </button>
    </form>
  )
}
```

Todo `name` do formulário corresponde exatamente a uma chave de
`newPostSchema` — é o contrato entre os dois, e um `name` divergente vira erro
de validação difícil de rastrear.

- [ ] **Step 5: Rodar, conferir a rota e commitar**

```powershell
npx vitest run tests/posts
npm run build
```

Expected: `/dashboard/new` e `/api/reddit/flairs` na lista de rotas. Atualize
`tests/nav/routes.test.ts` incluindo `/dashboard/new` nas implementadas.

```powershell
npm run verify
```

```bash
git add -A
git commit -m "feat: formulario de nova publicacao com flairs sob demanda"
```

---

### Task 9: Isolamento multiusuário e testes de ponta a ponta

**Files:**
- Test: `tests/db/scheduling-isolation.test.ts`
- Modify: `tests/nav/routes.test.ts`

**Interfaces:** nenhuma nova.

- [ ] **Step 1: Escrever a suíte de isolamento**

```ts
// tests/db/scheduling-isolation.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string
let subB: string
let postA: string
let comentarioA: string

async function montar(ownerId: string, sufixo: string) {
  const { data: conta } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_si_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()

  const { data: sub } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: conta!.id,
      subreddit_fullname: `t5_si_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
    })
    .select('id')
    .single()

  return { conta: conta!.id as string, sub: sub!.id as string }
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`si-a-${stamp}@teste.local`)
  userB = await createTestUser(`si-b-${stamp}@teste.local`)

  const a = await montar(userA.id, `a${stamp}`)
  const b = await montar(userB.id, `b${stamp}`)
  contaA = a.conta
  subA = a.sub
  contaB = b.conta
  subB = b.sub

  const { data: post } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: contaA,
      subreddit_id: subA,
      title: 'Post de A',
      url: 'https://exemplo.com/a',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
    })
    .select('id')
    .single()
  postA = post!.id as string

  const { data: comentario } = await adminClient()
    .from('scheduled_comments')
    .insert({
      owner_id: userA.id,
      scheduled_post_id: postA,
      reddit_account_id: contaA,
      body: 'Comentário de A',
      mode: 'immediate',
    })
    .select('id')
    .single()
  comentarioA = comentario!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('isolamento de publicações', () => {
  it('B não lê publicações de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .select('id')
      .eq('id', postA)
    expect(data).toHaveLength(0)
  })

  it('B não lê comentários de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .select('id')
      .eq('id', comentarioA)
    expect(data).toHaveLength(0)
  })

  it('B não altera publicação de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .update({ title: 'invadido' })
      .eq('id', postA)
      .select()
    expect(data ?? []).toHaveLength(0)

    const check = await adminClient()
      .from('scheduled_posts')
      .select('title')
      .eq('id', postA)
      .single()
    expect(check.data!.title).toBe('Post de A')
  })

  it('B não cancela publicação de A', async () => {
    await userClient(userB.accessToken)
      .from('scheduled_posts')
      .update({ status: 'cancelled' })
      .eq('id', postA)

    const check = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postA)
      .single()
    expect(check.data!.status).not.toBe('cancelled')
  })

  it('B não cria publicação com a conta de A', async () => {
    const { error } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .insert({
        owner_id: userB.id,
        reddit_account_id: contaA,
        subreddit_id: subA,
        title: 'Tentativa',
        url: 'https://exemplo.com/x',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
      })
    expect(error).not.toBeNull()
  })

  it('B não cria comentário no post de A', async () => {
    const { error } = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .insert({
        owner_id: userB.id,
        scheduled_post_id: postA,
        reddit_account_id: contaB,
        body: 'Comentário intruso',
        mode: 'immediate',
      })
    expect(error).not.toBeNull()
  })

  it('B não usa a comunidade de A com a própria conta', async () => {
    const { error } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .insert({
        owner_id: userB.id,
        reddit_account_id: contaB,
        subreddit_id: subA,
        title: 'Tentativa',
        url: 'https://exemplo.com/x',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
      })
    expect(error).not.toBeNull()
  })

  it('a listagem de B não contém nada de A', async () => {
    const posts = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .select('owner_id')
    expect((posts.data ?? []).every((p) => p.owner_id === userB.id)).toBe(true)

    const comentarios = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .select('owner_id')
    expect((comentarios.data ?? []).every((c) => c.owner_id === userB.id)).toBe(
      true,
    )
  })
})
```

- [ ] **Step 2: Atualizar o teste de rotas**

```ts
    const implementadas = [
      '/dashboard',
      '/dashboard/accounts',
      '/dashboard/communities',
      '/dashboard/new',
    ]
```

- [ ] **Step 3: Rodar, verificar e commitar**

```powershell
npx vitest run tests/db/scheduling-isolation.test.ts tests/nav
npm run verify
```

```bash
git add -A
git commit -m "test: isolamento multiusuario do agendamento"
```

---

### Task 10: Documentação

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Atualizar o estado atual**

```markdown
## Estado atual

**Planos 1 a 4 concluídos:** autenticação, banco com RLS, criptografia,
sanitização de logs, OAuth do Reddit, contas, configuração de rede,
comunidades, flairs, requisitos, orçamento de rate limit, e agendamento de
publicações com comentário automático. Falta o Plano 5:

| Plano | Escopo |
|---|---|
| 5 | Worker de publicação, calendário, fila, histórico, revisão |
```

- [ ] **Step 2: Registrar as decisões do Plano 4**

```markdown
### Decisões do Plano 4

- **Link e texto na mesma publicação é impossível na API do Reddit.** Quando
  o usuário fornece os dois, o texto vira comentário automático — usando
  endpoint oficial, e apenas com confirmação explícita no formulário.
- **Horário inexistente por horário de verão é recusado**, nunca deslocado em
  silêncio: publicar uma hora depois do combinado sem avisar seria pior que
  pedir outro horário. Horário ambíguo (que ocorre duas vezes) é aceito na
  primeira ocorrência, com aviso.
- **Publicação e comentário nascem na mesma transação.** Dois inserts
  sequenciais deixariam um post órfão se o segundo falhasse, e o worker
  publicaria sem o comentário pedido.
- **A máquina de estados vive em triggers**, não em convenção da aplicação:
  `needs_review` não volta para a fila, `published` e `cancelled` são
  terminais, e `processing` só retorna à fila quando o envio comprovadamente
  não saiu.
- **Falha ao ler requisitos bloqueia o agendamento** — herdado do Plano 3.
```

- [ ] **Step 3: Verificar e commitar**

```powershell
npm run verify
```

```bash
git add -A
git commit -m "docs: decisoes do plano 4"
```

---

## Critério de aceitação do Plano 4

- [ ] `npm run verify` verde e estável em execuções repetidas
- [ ] CHECK constraint recusa link post com corpo e self post com URL
- [ ] FKs compostas recusam conta de outro owner, comunidade de outro owner e comunidade que não é da conta escolhida
- [ ] `authenticated` não tem UPDATE em nenhuma coluna de execução; o trigger recusa mesmo com grant concedido
- [ ] `needs_review` não volta para `scheduled`; `published` e `cancelled` são terminais
- [ ] `processing` volta para `scheduled` apenas com `submit_attempted_at` nulo
- [ ] Horário inexistente por DST é recusado com mensagem clara
- [ ] Horário ambíguo é aceito na primeira ocorrência e sinalizado
- [ ] Round-trip de fuso preserva o horário digitado
- [ ] Título + link + texto produz link post com comentário automático, e só com confirmação
- [ ] Falha ao ler `post_requirements` impede o agendamento e não grava nada
- [ ] Post e comentário são criados atomicamente; falha em um não deixa o outro
- [ ] `owner_id` vem sempre da sessão, nunca do payload
- [ ] Edição, reagendamento e cancelamento só funcionam em `draft` e `scheduled`
- [ ] Cancelar a publicação cancela os comentários pendentes
- [ ] Usuário A não lê, altera, cancela nem usa recursos de B — em nenhuma das tabelas novas
- [ ] `npm run build` mostra `/dashboard/new` e `/api/reddit/flairs`
- [ ] `npx supabase db advisors --local` sem apontamentos
- [ ] Nenhum teste faz requisição real ao Reddit

## Verificação pendente

Somam-se às dos Planos 2 e 3, todas aguardando a aprovação da Reddit Data API:

- agendar uma publicação real e conferir, no banco, que `post_kind`, `url`,
  `body` e o comentário ficaram coerentes com o que o formulário mostrou;
- confirmar que o flair carregado pelo endpoint interno corresponde ao que o
  Reddit exibe na comunidade.

O worker que efetivamente publica é o Plano 5 — até lá, os agendamentos ficam
no banco aguardando, que é exatamente o estado esperado.

## O que vem no Plano 5

Fase 5 da spec: o worker standalone com claim atômico
(`FOR UPDATE SKIP LOCKED`), `submit_attempted_at`, reaper, `needs_review`,
retries por disposição e coordenador de rate limit — mais as páginas de
Calendário, Fila, Revisão e Histórico que leem tudo isso.
