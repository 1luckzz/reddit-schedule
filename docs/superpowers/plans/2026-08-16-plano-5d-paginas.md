# Plano 5 — Parte D: Reconciliação e Páginas

> Continuação de `2026-08-16-plano-5c-runners-e-loop.md`. As Global Constraints do
> arquivo principal valem integralmente.

Tasks 10 a 15 formam o **Bloco B**. Só comece depois do checkpoint do Bloco A:
estas telas mostram dados que apenas o worker produz.

**Regra que atravessa o bloco:** as páginas são somente leitura. As únicas
mutações permitidas são as que já existem (reagendar, cancelar) e a resolução
manual da Revisão. Nenhuma página publica nada no Reddit.

---

### Task 10: Reconciliação assistida

**Files:**
- Create: `src/lib/reddit/reconcile.ts`
- Create: `src/app/(dashboard)/dashboard/review/actions.ts`
- Create: `supabase/migrations/<timestamp>_resolve_review.sql`
- Test: `tests/reddit/reconcile.test.ts`
- Test: `tests/db/resolve-review.test.ts`

**Interfaces:**
- Produces:
  - `findCandidates(client, alvo): Promise<Candidate[]>`
  - RPC `resolve_needs_review(p_owner_id, p_post_id, p_decision, p_reddit_post_id, p_reddit_fullname, p_permalink)`
  - actions `checkOnReddit` (leitura) e `resolveReview` (decisão)

**O que a reconciliação é — e o que não é.** Ela **lê**
`GET /user/{username}/submitted` e mostra publicações compatíveis (mesmo
subreddit, mesmo título, dentro da janela de tempo do job). Quem decide é o
usuário. Ela nunca reenvia, nunca decide sozinha, e nunca é disparada pelo
reaper.

Sem isso, cada item em `needs_review` viraria trabalho manual de abrir o Reddit
e conferir na mão.

- [ ] **Step 1: Escrever os testes de reconciliação**

```ts
// tests/reddit/reconcile.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { findCandidates } from '@/lib/reddit/reconcile'

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
const submittedPath = (p: string) => p.includes('/submitted')
const client = () => createRedditClient({ accessToken: 'AT', dispatcher: agent })

const agora = Math.floor(Date.now() / 1000)

function t3(over: Record<string, unknown> = {}) {
  return {
    kind: 't3',
    data: {
      id: 'abc123',
      name: 't3_abc123',
      title: 'Meu título',
      subreddit: 'minhacomunidade',
      permalink: '/r/minhacomunidade/comments/abc123/meu_titulo/',
      created_utc: agora - 120,
      ...over,
    },
  }
}

const listing = (children: unknown[]) => ({
  kind: 'Listing',
  data: { after: null, children },
})

const alvo = {
  username: 'conta01',
  subredditName: 'minhacomunidade',
  title: 'Meu título',
  attemptedAt: new Date(Date.now() - 120_000),
}

describe('findCandidates', () => {
  it('encontra publicação compatível', async () => {
    pool().intercept({ path: submittedPath, method: 'GET' }).reply(200, listing([t3()]))

    const c = await findCandidates(client(), alvo)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({
      redditPostId: 'abc123',
      redditFullname: 't3_abc123',
      title: 'Meu título',
    })
    expect(c[0].permalink).toContain('reddit.com')
  })

  it('usa o endpoint do usuário informado', async () => {
    let url = ''
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, (opts) => {
        url = String(opts.path)
        return listing([])
      })

    await findCandidates(client(), alvo)
    expect(url).toContain('/user/conta01/submitted')
  })

  it('descarta publicação de outra comunidade', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ subreddit: 'outracomunidade' })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(0)
  })

  it('descarta publicação com título diferente', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ title: 'Outro assunto' })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(0)
  })

  it('compara título ignorando espaços e caixa', async () => {
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ title: '  MEU TÍTULO  ' })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(1)
  })

  it('descarta publicação fora da janela de tempo', async () => {
    // Publicada dois dias antes da tentativa: não pode ser esta.
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ created_utc: agora - 172_800 })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(0)
  })

  it('aceita publicação um pouco posterior à tentativa', async () => {
    // O Reddit pode registrar alguns segundos depois do envio.
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, listing([t3({ created_utc: agora - 100 })]))

    expect(await findCandidates(client(), alvo)).toHaveLength(1)
  })

  it('devolve lista vazia quando não há nada compatível', async () => {
    pool().intercept({ path: submittedPath, method: 'GET' }).reply(200, listing([]))
    expect(await findCandidates(client(), alvo)).toEqual([])
  })

  it('é uma leitura: usa GET e não marca efeito colateral', async () => {
    let metodo = ''
    pool()
      .intercept({ path: submittedPath, method: 'GET' })
      .reply(200, (opts) => {
        metodo = String(opts.method)
        return listing([])
      })

    await findCandidates(client(), alvo)
    expect(metodo).toBe('GET')
  })

  it('5xx propaga como retentável, sem inventar resultado', async () => {
    pool().intercept({ path: submittedPath, method: 'GET' }).reply(503, {})
    await expect(findCandidates(client(), alvo)).rejects.toMatchObject({
      disposition: 'retryable',
    })
  })
})
```

- [ ] **Step 2: Implementar a reconciliação**

```ts
// src/lib/reddit/reconcile.ts
import type { RedditClient } from './client'

/** Tolerância em torno do horário da tentativa, em segundos. */
const JANELA_SEGUNDOS = 3600

export type ReconcileTarget = {
  username: string
  subredditName: string
  title: string
  attemptedAt: Date
}

export type Candidate = {
  redditPostId: string
  redditFullname: string
  title: string
  permalink: string
  createdAt: Date
}

type Listing = {
  data?: {
    children?: { kind?: string; data?: Record<string, unknown> }[]
  }
}

const normalizar = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Procura publicações que possam corresponder a um job com resultado
 * desconhecido.
 *
 * É SEMPRE uma leitura. Não reenvia nada, não altera nada, e não decide: quem
 * confirma o vínculo é o usuário, na página de Revisão.
 */
export async function findCandidates(
  client: RedditClient,
  alvo: ReconcileTarget,
): Promise<Candidate[]> {
  const { data } = await client.request<Listing>({
    path: `/user/${alvo.username}/submitted`,
    query: { limit: '25', sort: 'new' },
  })

  const tituloAlvo = normalizar(alvo.title)
  const inicio = alvo.attemptedAt.getTime() - JANELA_SEGUNDOS * 1000
  const fim = alvo.attemptedAt.getTime() + JANELA_SEGUNDOS * 1000

  const encontrados: Candidate[] = []

  for (const child of data?.data?.children ?? []) {
    if (child.kind !== 't3' || !child.data) continue
    const d = child.data

    const subreddit = typeof d.subreddit === 'string' ? d.subreddit : ''
    const titulo = typeof d.title === 'string' ? d.title : ''
    const criado =
      typeof d.created_utc === 'number' ? d.created_utc * 1000 : null
    const fullname = typeof d.name === 'string' ? d.name : null
    const id = typeof d.id === 'string' ? d.id : null

    if (!fullname || !id || criado === null) continue
    if (subreddit.toLowerCase() !== alvo.subredditName.toLowerCase()) continue
    if (normalizar(titulo) !== tituloAlvo) continue
    if (criado < inicio || criado > fim) continue

    const permalink =
      typeof d.permalink === 'string'
        ? `https://www.reddit.com${d.permalink}`
        : `https://www.reddit.com/comments/${id}/`

    encontrados.push({
      redditPostId: id,
      redditFullname: fullname,
      title: titulo,
      permalink,
      createdAt: new Date(criado),
    })
  }

  return encontrados
}
```

- [ ] **Step 3: Escrever a migration de resolução**

```sql
-- Resolução manual de um job em needs_review.
--
-- Exclusiva do backend, como as demais RPCs de mutação: a decisão vem de uma
-- server action que já verificou a sessão.
create or replace function public.resolve_needs_review(
  p_owner_id uuid,
  p_post_id uuid,
  p_decision text,
  p_reddit_post_id text default null,
  p_reddit_fullname text default null,
  p_permalink text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_owner_id is null then
    raise exception 'Owner ausente.' using errcode = '42501';
  end if;

  if p_decision not in ('published', 'failed', 'cancelled') then
    raise exception 'Decisão inválida.' using errcode = '22023';
  end if;

  select status into v_status
  from public.scheduled_posts
  where id = p_post_id and owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Publicação não encontrada.' using errcode = '42501';
  end if;

  if v_status <> 'needs_review' then
    raise exception 'Só é possível resolver publicações em revisão.'
      using errcode = '42501';
  end if;

  -- Marcar como publicada exige o identificador: sem ele não há o que
  -- registrar, e o comentário programado não teria onde ser feito.
  if p_decision = 'published' and
     (p_reddit_post_id is null or p_reddit_fullname is null) then
    raise exception 'Informe a publicação encontrada no Reddit.'
      using errcode = '22023';
  end if;

  update public.scheduled_posts
  set status = p_decision,
      reddit_post_id = coalesce(p_reddit_post_id, reddit_post_id),
      reddit_fullname = coalesce(p_reddit_fullname, reddit_fullname),
      reddit_permalink = coalesce(p_permalink, reddit_permalink),
      published_at = case
        when p_decision = 'published' then coalesce(published_at, now())
        else published_at
      end,
      resolved_by = p_owner_id,
      resolved_at = now(),
      review_reason = null
  where id = p_post_id;

  -- Resolvido como publicado: os comentários programados voltam a fazer
  -- sentido e ganham horário a partir de agora.
  if p_decision = 'published' then
    perform public.materialize_comment_schedule(p_post_id, now());
  else
    -- Sem publicação, não há onde comentar.
    update public.scheduled_comments
    set status = 'cancelled'
    where scheduled_post_id = p_post_id
      and status in ('draft', 'scheduled');
  end if;
end;
$$;

revoke execute on function
  public.resolve_needs_review(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.resolve_needs_review(uuid, uuid, text, text, text, text)
  to service_role;
```

- [ ] **Step 4: Escrever os testes da resolução**

```ts
// tests/db/resolve-review.test.ts
// Arranjo: usuário, conta, comunidade e um post em needs_review com
// submit_attempted_at preenchido.
//
// Casos obrigatórios:
//   - resolver como published grava id, fullname, permalink e published_at
//   - resolver como published sem identificador é recusado
//   - resolver como failed cancela os comentários pendentes
//   - resolver como published materializa o horário dos comentários
//   - resolver post que não está em needs_review é recusado
//   - resolver post de outro owner é recusado
//   - authenticated e anon não têm EXECUTE na função
//   - resolved_by e resolved_at ficam preenchidos
```

- [ ] **Step 5: Implementar as actions**

```ts
// src/app/(dashboard)/dashboard/review/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { assertAccountAccess } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { getRedditClient } from '@/lib/reddit/reddit-client-factory'
import { findCandidates, type Candidate } from '@/lib/reddit/reconcile'
import { RedditError } from '@/lib/reddit/errors'

export type ReviewState = {
  error: string | null
  candidates: Candidate[] | null
  ok: boolean
}

const vazio = { candidates: null, ok: false }

/**
 * Consulta o Reddit em busca da publicação. Só lê — a decisão é do usuário.
 */
export async function checkOnReddit(
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const parsed = z
    .object({ postId: z.uuid() })
    .safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { ...vazio, error: 'Publicação inválida.' }

  try {
    const user = await requireUser()
    const supabase = await createServerSupabase()

    const { data: post } = await supabase
      .from('scheduled_posts')
      .select('id, owner_id, title, reddit_account_id, subreddit_id, submit_attempted_at')
      .eq('id', parsed.data.postId)
      .maybeSingle()

    if (!post || post.owner_id !== user.id) {
      return { ...vazio, error: 'Publicação não encontrada.' }
    }

    const { data: subreddit } = await supabase
      .from('subreddits')
      .select('name')
      .eq('id', post.subreddit_id)
      .single()

    const account = await assertAccountAccess(post.reddit_account_id)
    const client = await getRedditClient(account)

    const candidates = await findCandidates(client, {
      username: account.username,
      subredditName: subreddit!.name as string,
      title: post.title,
      attemptedAt: post.submit_attempted_at
        ? new Date(post.submit_attempted_at)
        : new Date(),
    })

    return { error: null, candidates, ok: true }
  } catch (e) {
    if (e instanceof RedditError) return { ...vazio, error: e.userMessage }
    return { ...vazio, error: 'Não foi possível consultar o Reddit agora.' }
  }
}

const resolveSchema = z.object({
  postId: z.uuid(),
  decision: z.enum(['published', 'failed', 'cancelled']),
  redditPostId: z.string().trim().optional(),
  redditFullname: z.string().trim().optional(),
  permalink: z.string().trim().optional(),
})

/**
 * Registra a decisão do usuário sobre um job em revisão.
 *
 * O owner vem de requireUser(), nunca do formulário — mesma regra do Plano 4.
 */
export async function resolveReview(
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const parsed = resolveSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { ...vazio, error: parsed.error.issues[0].message }
  }

  try {
    const user = await requireUser()
    const admin = createAdminSupabase()

    const { error } = await admin.rpc('resolve_needs_review', {
      p_owner_id: user.id,
      p_post_id: parsed.data.postId,
      p_decision: parsed.data.decision,
      p_reddit_post_id: parsed.data.redditPostId || null,
      p_reddit_fullname: parsed.data.redditFullname || null,
      p_permalink: parsed.data.permalink || null,
    })
    if (error) throw error
  } catch {
    return { ...vazio, error: 'Não foi possível registrar a decisão agora.' }
  }

  revalidatePath('/dashboard/review')
  revalidatePath('/dashboard/history')
  return { error: null, candidates: null, ok: true }
}
```

- [ ] **Step 6: Rodar, verificar e commitar**

```powershell
npx supabase db reset
npx vitest run tests/reddit/reconcile.test.ts tests/db/resolve-review.test.ts
npm run verify
```

```bash
git add -A
git commit -m "feat: reconciliacao assistida e resolucao manual de revisao"
```

---

### Task 11: Página de Revisão

**Files:**
- Create: `src/app/(dashboard)/dashboard/review/page.tsx`
- Create: `src/components/review/review-card.tsx`
- Test: `tests/review/page-security.test.ts`

**A página mais importante do bloco.** Ela existe porque o sistema recusa
adivinhar: quando o resultado é desconhecido, um humano decide.

Cada item mostra: título, conta, comunidade, horário da tentativa, motivo, e
dois caminhos — **Verificar no Reddit** (leitura) e a decisão manual.

- [ ] **Step 1: Escrever o teste de segurança**

```ts
// tests/review/page-security.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync(
  'src/app/(dashboard)/dashboard/review/page.tsx',
  'utf8',
)
const actions = readFileSync(
  'src/app/(dashboard)/dashboard/review/actions.ts',
  'utf8',
)

describe('página de revisão', () => {
  it('lê com o client do usuário', () => {
    expect(page).toContain('createServerSupabase')
    expect(page).not.toContain('createAdminSupabase')
  })

  it('mostra apenas itens em needs_review', () => {
    expect(page).toContain("'needs_review'")
  })

  it('não seleciona colunas sensíveis', () => {
    for (const proibido of ['access_token', 'refresh_token', 'proxy_password']) {
      expect(page).not.toContain(proibido)
    }
  })
})

describe('actions de revisão', () => {
  it('o owner vem da sessão, nunca do formulário', () => {
    expect(actions).toMatch(/p_owner_id:\s*user\.id/)
    expect(actions).not.toMatch(/p_owner_id:\s*parsed\./)
  })

  it('a verificação no Reddit é somente leitura', () => {
    const bloco = actions.slice(
      actions.indexOf('export async function checkOnReddit'),
      actions.indexOf('const resolveSchema'),
    )
    expect(bloco).toContain('findCandidates')
    // Nada de submitPost ou submitComment aqui.
    expect(bloco).not.toContain('submitPost')
    expect(bloco).not.toContain('submitComment')
  })

  it('a resolução usa a RPC exclusiva do backend', () => {
    expect(actions).toContain('resolve_needs_review')
    expect(actions).toContain('createAdminSupabase')
  })
})
```

- [ ] **Step 2: Implementar a página**

```tsx
// src/app/(dashboard)/dashboard/review/page.tsx
import { createServerSupabase } from '@/lib/supabase/server'
import { ReviewCard, type ReviewRow } from '@/components/review/review-card'

export default async function ReviewPage() {
  const supabase = await createServerSupabase()

  const { data: itens } = await supabase
    .from('scheduled_posts')
    .select(
      `id, title, review_reason, submit_attempted_at, scheduled_at, timezone,
       reddit_accounts ( username ),
       subreddits ( name )`,
    )
    .eq('status', 'needs_review')
    .order('submit_attempted_at', { ascending: false })

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Revisão
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Publicações cujo resultado não pôde ser confirmado. O sistema não
        tenta de novo sozinho, porque isso poderia publicar duas vezes.
      </p>

      {(itens ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Nada aguardando revisão.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {(itens as unknown as ReviewRow[]).map((item) => (
            <li key={item.id}>
              <ReviewCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

O `ReviewCard` é um Client Component com `useActionState` para `checkOnReddit`
e `resolveReview`. Estrutura obrigatória:

- cabeçalho com título, `u/conta → r/comunidade` e horário da tentativa;
- explicação do motivo, traduzida (`OUTCOME_UNKNOWN_WORKER_DIED` vira "o
  processo de publicação foi interrompido antes de confirmar o resultado");
- botão **Verificar no Reddit**, que lista os candidatos com título, horário e
  link — cada um com um botão **É esta** que envia `decision=published` mais
  os identificadores;
- botão **Não foi publicada**, que envia `decision=failed`;
- aviso de que a verificação é apenas uma leitura e que a decisão é do usuário.

- [ ] **Step 3: Atualizar rotas e commitar**

Acrescente `/dashboard/review` à lista de implementadas em
`tests/nav/routes.test.ts`.

```powershell
npx vitest run tests/review tests/nav
npm run build
npm run verify
```

```bash
git add -A
git commit -m "feat: pagina de revisao com reconciliacao assistida"
```

---

### Task 12: Página de Fila

**Files:**
- Create: `src/app/(dashboard)/dashboard/queue/page.tsx`
- Create: `src/components/queue/queue-table.tsx`
- Create: `src/components/queue/queue-filters.tsx`
- Test: `tests/queue/page-security.test.ts`

Mostra o que está por vir, em ordem cronológica, com filtros por conta,
comunidade, status e período — e as ações de reagendar e cancelar que já
existem desde o Plano 4.

- [ ] **Step 1: Escrever o teste**

```ts
// tests/queue/page-security.test.ts
// Casos obrigatórios:
//   - lê com o client do usuário, nunca com o admin
//   - não seleciona colunas sensíveis
//   - filtros são aplicados na consulta, não só no cliente
//   - a tabela só oferece reagendar/cancelar em draft e scheduled
//   - a página não importa submitPost nem submitComment
```

- [ ] **Step 2: Implementar**

A página recebe os filtros por `searchParams` e monta a consulta com eles.
Colunas exibidas: horário local (convertido com `fromUtc` e o `timezone` da
linha), `u/conta`, `r/comunidade`, título e status traduzido.

O status vira rótulo em português com cor:

| Status | Rótulo |
|---|---|
| `draft` | Rascunho |
| `scheduled` | Programado |
| `processing` | Publicando agora |
| `published` | Publicado |
| `failed` | Falhou |
| `cancelled` | Cancelado |
| `needs_review` | Aguardando revisão |

Reagendar e cancelar aparecem **apenas** em `draft` e `scheduled` — a mesma
regra que o trigger e a RPC já impõem. A UI não é a barreira; ela só evita
oferecer o que vai ser recusado.

- [ ] **Step 3: Verificar e commitar**

```bash
git commit -m "feat: pagina de fila com filtros e acoes permitidas"
```

---

### Task 13: Página de Histórico

**Files:**
- Create: `src/app/(dashboard)/dashboard/history/page.tsx`
- Create: `src/components/history/history-table.tsx`
- Test: `tests/history/page-security.test.ts`

Mostra `published`, `failed` e `cancelled`. Para publicados: horário
**planejado** e horário **real**, `reddit_post_id`, permalink e botão
**Abrir no Reddit**.

A diferença entre planejado e real é informação de operação: revela atraso de
fila, retentativas e resolução manual.

- [ ] **Step 1: Escrever o teste**

```ts
// tests/history/page-security.test.ts
// Casos obrigatórios:
//   - mostra apenas published, failed e cancelled
//   - o link para o Reddit usa rel="noopener noreferrer" e target="_blank"
//   - mostra horário planejado e horário real lado a lado
//   - itens resolvidos manualmente ficam marcados como tal
//   - não seleciona colunas sensíveis
//   - a mensagem de erro exibida é a humana, não o código interno
```

- [ ] **Step 2: Implementar e commitar**

```bash
git commit -m "feat: pagina de historico com permalink e horarios"
```

---

### Task 14: Página de Calendário

**Files:**
- Create: `src/app/(dashboard)/dashboard/calendar/page.tsx`
- Create: `src/components/calendar/month-grid.tsx`
- Create: `src/lib/scheduling/calendar.ts`
- Test: `tests/scheduling/calendar.test.ts`

**Interfaces:**
- Produces:
  - `buildMonthGrid(year, month, timeZone): Day[]` — semanas completas
  - `groupByDay(posts, timeZone): Map<string, Post[]>`

**Cuidado central:** o agrupamento por dia usa o **fuso do usuário**, não o do
servidor. Uma publicação às 22h em São Paulo é 01h do dia seguinte em UTC, e
agrupar por UTC a colocaria no dia errado do calendário.

- [ ] **Step 1: Escrever os testes**

```ts
// tests/scheduling/calendar.test.ts
// Casos obrigatórios:
//   - a grade do mês começa no domingo e termina no sábado
//   - a grade cobre todos os dias do mês
//   - dias de outros meses aparecem marcados como tal
//   - fevereiro de ano bissexto tem 29 dias
//   - agrupa publicação de 22h em São Paulo no dia correto, não no seguinte
//   - a mesma publicação cai em dias diferentes conforme o fuso escolhido
//   - dia sem publicação devolve lista vazia, não undefined
```

- [ ] **Step 2: Implementar e commitar**

Cada célula mostra até três cards (`HH:MM`, `u/conta`, `r/comunidade`, título
truncado, status) e um indicador de "+N" quando houver mais. Clicar abre os
detalhes, com as mesmas ações da Fila.

```bash
git commit -m "feat: calendario mensal no fuso do usuario"
```

---

### Task 15: Dashboard, status do worker e fechamento

**Files:**
- Modify: `src/app/(dashboard)/dashboard/page.tsx`
- Create: `src/app/(dashboard)/dashboard/settings/page.tsx`
- Create: `src/app/(dashboard)/dashboard/logs/page.tsx`
- Modify: `README.md`
- Test: `tests/dashboard/page-security.test.ts`

**Dashboard:** os quatro indicadores da spec (Hoje, Publicados, Pendentes,
Falhas), um alerta destacado quando houver itens em revisão, e as próximas
publicações.

**Status do worker:** a página de Configurações mostra quando o worker rodou
pela última vez — derivado do `execution_logs` mais recente — e o orçamento
de rate limit atual. Se não houver atividade recente, exibe um aviso claro de
que os agendamentos não estão sendo processados.

**Logs:** lista `execution_logs` do usuário, com filtro por ação e desfecho.
Os registros já chegam sanitizados do worker.

- [ ] **Step 1: Escrever o teste**

```ts
// tests/dashboard/page-security.test.ts
// Casos obrigatórios:
//   - os contadores usam o fuso do perfil para definir "hoje"
//   - o alerta de revisão só aparece quando há itens
//   - o status do worker avisa quando não há atividade recente
//   - a página de logs não expõe coluna sensível
//   - nenhuma das três páginas usa o client administrativo
//   - o client secret do Reddit nunca é exibido em Configurações
```

- [ ] **Step 2: Implementar as páginas**

Em Configurações, o campo de integração Reddit mostra **apenas** se está
configurada — nunca o `client_secret`, nem parcialmente. O intervalo do worker
é exibido como leitura, porque é definido por variável de ambiente no VPS.

- [ ] **Step 3: Atualizar o README**

```markdown
## Estado atual

**Planos 1 a 5 concluídos.** O sistema está completo: conectar contas,
sincronizar comunidades, agendar publicações com comentário automático, e
publicar automaticamente no horário marcado.

### Decisões do Plano 5

- **At-most-one concurrent claim, não exactly-once.** `FOR UPDATE SKIP LOCKED`
  garante que dois workers nunca processem o mesmo job ao mesmo tempo. A
  janela entre enviar e gravar o resultado é tratada por `submit_attempted_at`
  e pela revisão manual — não por locking, que não a alcança.
- **Resultado desconhecido nunca é retentado.** Vai para revisão, onde a
  reconciliação assistida lê o Reddit e mostra candidatos; quem decide é você.
- **Retentativa por disposição:** retentável entra em backoff, terminal falha
  na hora, desconhecido vai para revisão. `Retry-After` só é obedecido quando
  aumenta a espera — encurtar seria insistir mais cedo do que o combinado.
- **O worker pode esperar; o painel não.** Orçamento esgotado faz o worker
  dormir até o reset, enquanto no painel a mesma situação vira mensagem ao
  usuário — segurar uma requisição HTTP dormindo seria inaceitável.
```

- [ ] **Step 4: Verificar e commitar**

```powershell
npm run verify
npm run build
```

```bash
git add -A
git commit -m "feat: dashboard, status do worker e paginas de logs"
```

---

## Critério de aceitação do Plano 5

### Bloco A — worker

- [ ] Claim concorrente nunca entrega o mesmo job a dois workers
- [ ] `submit_attempted_at` gravado e commitado antes do envio, verificado de dentro do mock
- [ ] `unknown` vira `needs_review` sem retry e sem `next_attempt_at`
- [ ] `terminal` falha na hora, sem consumir tentativas
- [ ] `retryable` respeita backoff crescente e não acelera com `Retry-After` menor
- [ ] Reaper devolve à fila apenas jobs com `submit_attempted_at` nulo
- [ ] Reaper é idempotente: rodar duas vezes não muda nada
- [ ] Falha ao ler `post_requirements` não publica
- [ ] Requisito que passou a ser violado vira falha, não publicação
- [ ] Conta desconectada não tem job pego pelo claim
- [ ] Espaçamento mínimo por conta é respeitado
- [ ] Comentário só é publicado com post pai `published` e `reddit_fullname`
- [ ] Comentário com horário absoluto vencido fica elegível logo após a publicação
- [ ] Logs não contêm token, senha de proxy, header de autorização nem URL com credenciais
- [ ] `authenticated` e `anon` sem EXECUTE nas funções de claim, reaper e resolução
- [ ] Worker encerra graciosamente com SIGTERM
- [ ] Imagem Docker constrói e roda como usuário não-root

### Bloco B — visualização

- [ ] Todas as páginas leem com o client do usuário, nunca com o admin
- [ ] Nenhuma página seleciona coluna sensível
- [ ] Reconciliação é somente leitura e nunca decide sozinha
- [ ] Resolver como publicado exige o identificador da publicação
- [ ] Resolver como falho cancela os comentários pendentes
- [ ] Reagendar e cancelar aparecem só em `draft` e `scheduled`
- [ ] Calendário agrupa por dia no fuso do usuário, não do servidor
- [ ] Histórico mostra horário planejado e real
- [ ] Configurações nunca exibe o `client_secret`
- [ ] Status do worker avisa quando não há atividade recente

### Geral

- [ ] `npm run verify` verde e estável em execuções repetidas
- [ ] `npm run build` sem erro, com todas as rotas esperadas
- [ ] `npx supabase db advisors --local` sem apontamentos
- [ ] Nenhum teste faz requisição real ao Reddit

## Verificação pendente

Somam-se às dos Planos 2, 3 e 4, todas aguardando a aprovação da Reddit Data
API. A do Plano 5 é a mais delicada e deve ser feita **em comunidade de teste
própria**, nunca em produção:

1. agendar uma publicação para dali a poucos minutos e conferir que o worker a
   publica, com permalink correto no Histórico;
2. conferir que o comentário automático aparece depois da publicação, pela
   mesma conta;
3. simular indisponibilidade (derrubar a rede no meio do envio) e confirmar
   que o job vai para revisão em vez de duplicar;
4. usar a reconciliação assistida para resolver esse job e conferir que o
   permalink gravado é o correto.

O item 3 é o único que exige interrupção deliberada, e é o que valida a
decisão central do sistema: **na dúvida, não republicar**.
