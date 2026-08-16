# Reddit Post Scheduler — Plano 2: OAuth, Contas Reddit e Configuração de Rede

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar múltiplas contas Reddit via OAuth oficial, guardar os segredos de forma inalcançável pelo cliente, renovar tokens sozinho e permitir uma configuração de rede opcional por conta.

**Architecture:** Segredos vivem em tabelas satélite sem policy nem grant, alcançáveis apenas pelo `service_role` e sempre atrás de um helper que exige posse já verificada — expressa no tipo `VerifiedAccount`, de modo que trocar um UUID não compile. O `state` do OAuth é de uso único, vinculado à sessão Supabase e consumido por um UPDATE condicional. Todo tráfego para o Reddit passa por um cliente único que injeta credenciais, lê os headers de rate limit e traduz respostas em erros com disposição explícita (`retryable` / `unknown` / `terminal`).

**Tech Stack:** as do Plano 1, mais `undici` `^8.10.0` (HTTP e proxy por conta).

**Spec:** `docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md` (revisão 2, aprovada)

**Plano anterior:** `docs/superpowers/plans/2026-08-16-plano-1-fundacao-e-auth.md` (concluído)

**Fase da spec coberta:** 2.

## Global Constraints

Valem para toda task. As do Plano 1 continuam valendo integralmente; estas se somam.

- **Credenciais do Reddit vivem exclusivamente em `.env.local`.** Nunca em commit, log, teste, README, comentário ou código-fonte. Nenhum teste usa credenciais reais: a API do Reddit é sempre simulada com `undici.MockAgent`, e a suíte precisa passar numa máquina que **não** tenha `REDDIT_CLIENT_ID` configurado.
- **Nenhuma requisição real ao Reddit em teste.** Um teste que dependa de rede externa é um teste quebrado.
- **Tabelas de segredo** (`reddit_account_secrets`, `reddit_account_network_configs`, `oauth_states`): RLS habilitada, zero policies, `revoke all` explícito de `anon` e `authenticated`.
- **Grants são obrigatórios e explícitos** em toda tabela nova alcançável pelo cliente — RLS decide quais linhas, grant decide se a tabela é alcançável (lição da Task 5 do Plano 1).
- **`service_role` só depois de verificar posse.** Toda função que lê segredo recebe `VerifiedAccount`, nunca `string`. A marca de tipo é ergonomia, não fronteira: a garantia vem da checagem de posse em runtime, da RLS, das constraints e dos testes A/B.
- **Prova de criptografia nunca é o prefixo do envelope.** Um teste que só confere `v1.` passaria com o texto claro concatenado. Todo teste de segredo verifica: valor armazenado difere do claro, não contém o claro (nem em base64 ou hex), e o decrypt devolve o original.
- **Criptografia:** `encryptSecret(valor, aad)` com AAD no formato `<tabela>:<coluna>:<reddit_account_id>`.
- **`fetch` e `ProxyAgent` sempre da dependência `undici` instalada**, nunca do `fetch` global do Node.
- **Route handlers que falam com o Reddit declaram `export const runtime = 'nodejs'`** — o `ProxyAgent` não existe no runtime Edge.
- **Proxy é configuração fixa da conta.** Sem rotação, sem pool, sem troca de IP após erro, sem retry de 403 por outra rota, sem qualquer forma de bypass.
- **Disposição de erro** (`retryable` / `unknown` / `terminal`) é decidida em um lugar só: `src/lib/reddit/errors.ts`.
- **Portão de task:** `npm run verify` verde antes de commitar.

## Pré-requisito

`.env.local` com `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_REDIRECT_URI` e `REDDIT_USER_AGENT` preenchidos (README, Fase -1). Necessário **apenas** para a verificação manual da Task 9; as Tasks 1 a 8 e todos os testes rodam sem eles.

---

### Task 1: Schema de contas, segredos e configuração de rede

**Files:**
- Create: `supabase/migrations/<timestamp>_reddit_accounts.sql`
- Test: `tests/db/reddit-accounts.test.ts`

**Interfaces:**
- Consumes: `public.profiles` (Plano 1)
- Produces: tabelas `reddit_accounts`, `reddit_account_secrets`, `reddit_account_network_configs`; view `reddit_account_network_status`; funções `public.mask_host(text)` e `public.sync_proxy_status()`

- [ ] **Step 1: Criar o arquivo de migration pelo CLI**

```powershell
npx supabase migration new reddit_accounts
```

- [ ] **Step 2: Escrever os testes de integração falhando**

```ts
// tests/db/reddit-accounts.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { maskHost } from '@/lib/logging/sanitize'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let accountA: string
let accountB: string

async function createAccount(ownerId: string, username: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_${username}`,
      username,
      scopes: ['identity', 'submit'],
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`ra-a-${stamp}@teste.local`)
  userB = await createTestUser(`ra-b-${stamp}@teste.local`)
  accountA = await createAccount(userA.id, `conta_a_${stamp}`)
  accountB = await createAccount(userB.id, `conta_b_${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('reddit_accounts', () => {
  it('o usuário lê apenas as próprias contas', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .select('id')
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(accountA)
  })

  it('o usuário A não enxerga a conta de B nem pedindo pelo id', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .select('id')
      .eq('id', accountB)
    expect(data).toHaveLength(0)
  })

  it('o usuário A não altera a conta de B', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .update({ username: 'invadido' })
      .eq('id', accountB)
      .select()
    expect(data).toHaveLength(0)

    const check = await adminClient()
      .from('reddit_accounts')
      .select('username')
      .eq('id', accountB)
      .single()
    expect(check.data!.username).not.toBe('invadido')
  })

  it('o usuário não consegue inserir conta para outro owner', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .insert({
        owner_id: userB.id,
        reddit_user_id: 't2_forjado',
        username: 'forjado',
      })
    expect(error).not.toBeNull()
  })

  it('impede duas contas com o mesmo reddit_user_id para o mesmo owner', async () => {
    const redditUserId = `t2_dup_${Date.now()}`
    const primeira = await adminClient().from('reddit_accounts').insert({
      owner_id: userA.id,
      reddit_user_id: redditUserId,
      username: 'dup',
    })
    expect(primeira.error).toBeNull()

    const segunda = await adminClient().from('reddit_accounts').insert({
      owner_id: userA.id,
      reddit_user_id: redditUserId,
      username: 'dup2',
    })
    expect(segunda.error).not.toBeNull()
  })

  it('permite o mesmo reddit_user_id para owners diferentes', async () => {
    const redditUserId = `t2_compartilhado_${Date.now()}`
    const a = await adminClient().from('reddit_accounts').insert({
      owner_id: userA.id,
      reddit_user_id: redditUserId,
      username: 'mesma_conta',
    })
    const b = await adminClient().from('reddit_accounts').insert({
      owner_id: userB.id,
      reddit_user_id: redditUserId,
      username: 'mesma_conta',
    })
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
  })

  it('rejeita status fora da lista permitida', async () => {
    const { error } = await adminClient()
      .from('reddit_accounts')
      .update({ status: 'inventado' })
      .eq('id', accountA)
    expect(error).not.toBeNull()
  })
})

describe('reddit_account_secrets', () => {
  beforeAll(async () => {
    const { error } = await adminClient().from('reddit_account_secrets').insert({
      reddit_account_id: accountA,
      owner_id: userA.id,
      access_token_enc: 'v1.aaa.bbb.ccc',
      refresh_token_enc: 'v1.ddd.eee.fff',
      access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    if (error) throw error
  })

  it('o dono da conta NÃO consegue ler os próprios segredos pelo Data API', async () => {
    const { data, error } = await userClient(userA.accessToken)
      .from('reddit_account_secrets')
      .select('access_token_enc')
    // Sem grant e sem policy: erro de permissão ou zero linhas, nunca o token.
    expect(data ?? []).toHaveLength(0)
    expect(JSON.stringify({ data, error })).not.toContain('v1.aaa')
  })

  it('o usuário B também não consegue', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('reddit_account_secrets')
      .select('access_token_enc')
    expect(data ?? []).toHaveLength(0)
  })

  it('rejeita segredo cujo owner_id diverge do owner da conta', async () => {
    const { error } = await adminClient().from('reddit_account_secrets').insert({
      reddit_account_id: accountB,
      owner_id: userA.id, // owner errado de propósito
      access_token_enc: 'v1.x.y.z',
      refresh_token_enc: 'v1.x.y.z',
      access_token_expires_at: new Date().toISOString(),
    })
    expect(error).not.toBeNull()
  })

  it('apagar a conta apaga os segredos em cascata', async () => {
    const temp = await createAccount(userA.id, `tmp_${Date.now()}`)
    await adminClient().from('reddit_account_secrets').insert({
      reddit_account_id: temp,
      owner_id: userA.id,
      access_token_enc: 'v1.a.b.c',
      refresh_token_enc: 'v1.a.b.c',
      access_token_expires_at: new Date().toISOString(),
    })
    await adminClient().from('reddit_accounts').delete().eq('id', temp)
    const { data } = await adminClient()
      .from('reddit_account_secrets')
      .select('reddit_account_id')
      .eq('reddit_account_id', temp)
    expect(data).toHaveLength(0)
  })
})

describe('reddit_account_network_configs', () => {
  beforeAll(async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .insert({
        reddit_account_id: accountA,
        owner_id: userA.id,
        proxy_enabled: true,
        proxy_protocol: 'socks5',
        proxy_host: 'proxy.exemplo.com',
        proxy_port: 1080,
        proxy_username: 'usuario',
        proxy_password_enc: 'v1.ggg.hhh.iii',
      })
    if (error) throw error
  })

  it('o dono NÃO consegue ler a configuração crua pelo Data API', async () => {
    const { data, error } = await userClient(userA.accessToken)
      .from('reddit_account_network_configs')
      .select('proxy_username, proxy_password_enc, proxy_host')
    expect(data ?? []).toHaveLength(0)
    const payload = JSON.stringify({ data, error })
    expect(payload).not.toContain('usuario')
    expect(payload).not.toContain('v1.ggg')
    expect(payload).not.toContain('proxy.exemplo.com')
  })

  it('exige host, porta e protocolo quando o proxy está habilitado', async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .update({ proxy_host: null })
      .eq('reddit_account_id', accountA)
    expect(error).not.toBeNull()
  })

  it('rejeita protocolo fora da lista permitida', async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .update({ proxy_protocol: 'ftp' })
      .eq('reddit_account_id', accountA)
    expect(error).not.toBeNull()
  })

  it('rejeita porta fora da faixa válida', async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .update({ proxy_port: 70000 })
      .eq('reddit_account_id', accountA)
    expect(error).not.toBeNull()
  })
})

describe('reddit_account_network_status (view)', () => {
  it('o dono vê o status com host mascarado', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_account_network_status')
      .select('*')
      .eq('reddit_account_id', accountA)
      .single()
    expect(data!.proxy_enabled).toBe(true)
    expect(data!.proxy_protocol).toBe('socks5')
    expect(data!.proxy_port).toBe(1080)
    expect(data!.proxy_host_masked).toBe('pr***.exemplo.com')
  })

  it('a view nunca expõe usuário, senha ou host completo', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_account_network_status')
      .select('*')
      .eq('reddit_account_id', accountA)
      .single()
    const payload = JSON.stringify(data)
    expect(payload).not.toContain('usuario')
    expect(payload).not.toContain('v1.ggg')
    expect(payload).not.toContain('proxy.exemplo.com')
  })

  it('o usuário B não vê o status das contas de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('reddit_account_network_status')
      .select('reddit_account_id')
      .eq('reddit_account_id', accountA)
    expect(data).toHaveLength(0)
  })

  it('o mascaramento em SQL bate com o de TypeScript', async () => {
    const casos = ['proxy.exemplo.com', '203.0.113.9', 'a.b', 'localhost']
    for (const host of casos) {
      const { data } = await adminClient().rpc('mask_host', { host })
      expect(data).toBe(maskHost(host))
    }
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/db/reddit-accounts.test.ts`
Expected: FAIL — as relações não existem.

- [ ] **Step 4: Escrever a migration**

```sql
-- ---------------------------------------------------------------
-- Contas Reddit conectadas pelo usuário do painel.
-- ---------------------------------------------------------------
create table public.reddit_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reddit_user_id text not null,
  username text not null,
  scopes text[] not null default '{}',
  status text not null default 'connected'
    check (status in ('connected', 'expired', 'disconnected', 'revoked')),
  last_authenticated_at timestamptz,
  last_error text,
  min_interval_seconds integer not null default 300
    check (min_interval_seconds >= 0),
  last_submit_at timestamptz,

  -- Derivados de reddit_account_network_configs, mantidos por trigger.
  -- Existem aqui porque a view de status precisa de security_invoker, e uma
  -- view com security_invoker sobre uma tabela sem policy devolveria zero
  -- linhas. Só dados não sensíveis: host já mascarado, sem usuário nem senha.
  proxy_enabled boolean not null default false,
  proxy_protocol text,
  proxy_host_masked text,
  proxy_port integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (owner_id, reddit_user_id),
  -- Alvo das FKs compostas: garante no banco que conta e recurso filho
  -- pertencem ao mesmo owner.
  unique (id, owner_id)
);

create index reddit_accounts_owner_idx on public.reddit_accounts (owner_id);

alter table public.reddit_accounts enable row level security;

grant select, insert, update, delete on public.reddit_accounts to authenticated;
grant all on public.reddit_accounts to service_role;

create policy "reddit_accounts_select_own"
  on public.reddit_accounts for select
  to authenticated
  using ( (select auth.uid()) = owner_id );

create policy "reddit_accounts_insert_own"
  on public.reddit_accounts for insert
  to authenticated
  with check ( (select auth.uid()) = owner_id );

create policy "reddit_accounts_update_own"
  on public.reddit_accounts for update
  to authenticated
  using ( (select auth.uid()) = owner_id )
  with check ( (select auth.uid()) = owner_id );

create policy "reddit_accounts_delete_own"
  on public.reddit_accounts for delete
  to authenticated
  using ( (select auth.uid()) = owner_id );

create trigger reddit_accounts_set_updated_at
  before update on public.reddit_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Segredos. Sem policy e sem grant: inalcançáveis pelo Data API.
-- ---------------------------------------------------------------
create table public.reddit_account_secrets (
  reddit_account_id uuid primary key
    references public.reddit_accounts (id) on delete cascade,
  owner_id uuid not null,
  access_token_enc text not null,
  refresh_token_enc text not null,
  access_token_expires_at timestamptz not null,
  refresh_lock_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (reddit_account_id, owner_id)
    references public.reddit_accounts (id, owner_id) on delete cascade
);

alter table public.reddit_account_secrets enable row level security;

revoke all on public.reddit_account_secrets from anon, authenticated;
grant all on public.reddit_account_secrets to service_role;

create trigger reddit_account_secrets_set_updated_at
  before update on public.reddit_account_secrets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Configuração de rede opcional por conta. Também inalcançável.
-- ---------------------------------------------------------------
create table public.reddit_account_network_configs (
  reddit_account_id uuid primary key
    references public.reddit_accounts (id) on delete cascade,
  owner_id uuid not null,
  proxy_enabled boolean not null default false,
  proxy_protocol text check (proxy_protocol in ('http', 'https', 'socks5')),
  proxy_host text,
  proxy_port integer check (proxy_port between 1 and 65535),
  proxy_username text,
  proxy_password_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (reddit_account_id, owner_id)
    references public.reddit_accounts (id, owner_id) on delete cascade,

  constraint proxy_config_complete check (
    not proxy_enabled
    or (proxy_protocol is not null
        and proxy_host is not null
        and proxy_port is not null)
  )
);

alter table public.reddit_account_network_configs enable row level security;

revoke all on public.reddit_account_network_configs from anon, authenticated;
grant all on public.reddit_account_network_configs to service_role;

create trigger reddit_account_network_configs_set_updated_at
  before update on public.reddit_account_network_configs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Mascaramento de host. Espelha maskHost() de src/lib/logging/sanitize.ts;
-- um teste compara as duas implementações para impedir divergência.
-- ---------------------------------------------------------------
create or replace function public.mask_host(host text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  dot integer;
begin
  if host is null then
    return null;
  end if;

  if host ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$' then
    return regexp_replace(host, '\.\d{1,3}$', '.***');
  end if;

  dot := position('.' in host);
  if dot = 0 then
    return '***';
  end if;

  if dot - 1 <= 2 then
    return '***' || substring(host from dot);
  end if;

  return substring(host from 1 for 2) || '***' || substring(host from dot);
end;
$$;

grant execute on function public.mask_host(text) to authenticated, service_role;

-- Mantém os campos derivados em reddit_accounts em sincronia.
create or replace function public.sync_proxy_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.reddit_accounts
    set proxy_enabled = false,
        proxy_protocol = null,
        proxy_host_masked = null,
        proxy_port = null
    where id = old.reddit_account_id;
    return old;
  end if;

  update public.reddit_accounts
  set proxy_enabled = new.proxy_enabled,
      proxy_protocol = case when new.proxy_enabled then new.proxy_protocol end,
      proxy_host_masked = case when new.proxy_enabled
                               then public.mask_host(new.proxy_host) end,
      proxy_port = case when new.proxy_enabled then new.proxy_port end
  where id = new.reddit_account_id;
  return new;
end;
$$;

revoke execute on function public.sync_proxy_status() from public, anon, authenticated;

create trigger network_configs_sync_proxy_status
  after insert or update or delete on public.reddit_account_network_configs
  for each row execute function public.sync_proxy_status();

-- ---------------------------------------------------------------
-- View de status: security_invoker, apenas dados não sensíveis.
-- ---------------------------------------------------------------
create view public.reddit_account_network_status
with (security_invoker = true) as
select
  id as reddit_account_id,
  proxy_enabled,
  proxy_protocol,
  proxy_host_masked,
  proxy_port
from public.reddit_accounts;

grant select on public.reddit_account_network_status to authenticated;
```

- [ ] **Step 5: Aplicar e rodar os testes**

```powershell
npx supabase db reset
npx vitest run tests/db/reddit-accounts.test.ts
```

Expected: PASS. Se o `db reset` falhar com erro de container, repita — é transiente (visto no Plano 1).

- [ ] **Step 6: Rodar os advisors**

Run: `npx supabase db advisors --local --type security`
Expected: `No issues found`. Atenção especial a avisos sobre a view — se aparecer algo sobre `security_definer`, a cláusula `with (security_invoker = true)` não foi aplicada.

- [ ] **Step 7: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: schema de contas reddit, segredos e configuracao de rede"
```

---

### Task 2: Schema de `oauth_states`

**Files:**
- Create: `supabase/migrations/<timestamp>_oauth_states.sql`
- Test: `tests/db/oauth-states.test.ts`

**Interfaces:**
- Produces: tabela `public.oauth_states`

O consumo é um único `UPDATE` condicional, e é ele que torna o replay impossível: o segundo callback não encontra linha para atualizar. Não há função SQL — a atomicidade vem da própria instrução.

- [ ] **Step 1: Criar o arquivo de migration**

```powershell
npx supabase migration new oauth_states
```

- [ ] **Step 2: Escrever os testes falhando**

```ts
// tests/db/oauth-states.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }

const hash = (v: string) => createHash('sha256').update(v).digest('hex')

async function insertState(ownerId: string, value: string, ttlMs = 600_000) {
  const { error } = await adminClient().from('oauth_states').insert({
    owner_id: ownerId,
    state_hash: hash(value),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  })
  if (error) throw error
}

/** Mesmo UPDATE condicional que o callback usa. */
async function consume(value: string) {
  return adminClient()
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state_hash', hash(value))
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('owner_id')
}

beforeAll(async () => {
  userA = await createTestUser(`os-${Date.now()}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('oauth_states', () => {
  it('consome um state válido uma vez', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const { data } = await consume(value)
    expect(data).toHaveLength(1)
    expect(data![0].owner_id).toBe(userA.id)
  })

  it('recusa o mesmo state numa segunda tentativa (replay)', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const first = await consume(value)
    expect(first.data).toHaveLength(1)

    const second = await consume(value)
    expect(second.data).toHaveLength(0)
  })

  it('recusa state expirado', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value, -1000)
    const { data } = await consume(value)
    expect(data).toHaveLength(0)
  })

  it('recusa state inexistente', async () => {
    const { data } = await consume(randomBytes(32).toString('base64url'))
    expect(data).toHaveLength(0)
  })

  it('duas tentativas concorrentes: exatamente uma vence', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const [a, b] = await Promise.all([consume(value), consume(value)])
    const vencedores = [a.data?.length ?? 0, b.data?.length ?? 0]
    expect(vencedores.filter((n) => n === 1)).toHaveLength(1)
    expect(vencedores.filter((n) => n === 0)).toHaveLength(1)
  })

  it('não guarda o valor cru do state, apenas o hash', async () => {
    const value = randomBytes(32).toString('base64url')
    await insertState(userA.id, value)
    const { data } = await adminClient()
      .from('oauth_states')
      .select('*')
      .eq('state_hash', hash(value))
      .single()
    expect(JSON.stringify(data)).not.toContain(value)
  })

  it('o cliente não alcança a tabela pelo Data API', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('oauth_states')
      .select('state_hash')
    expect(data ?? []).toHaveLength(0)
  })

  it('apagar o usuário apaga os states em cascata', async () => {
    const temp = await createTestUser(`os-tmp-${Date.now()}@teste.local`)
    const value = randomBytes(32).toString('base64url')
    await insertState(temp.id, value)
    await cleanupTestUsers([temp.id])
    const { data } = await adminClient()
      .from('oauth_states')
      .select('id')
      .eq('state_hash', hash(value))
    expect(data).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/db/oauth-states.test.ts`
Expected: FAIL — a relação não existe.

- [ ] **Step 4: Escrever a migration**

```sql
create table public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Apenas o SHA-256. O valor cru existe somente no cookie httpOnly.
  state_hash text not null unique,
  redirect_to text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index oauth_states_expires_idx on public.oauth_states (expires_at);

alter table public.oauth_states enable row level security;

revoke all on public.oauth_states from anon, authenticated;
grant all on public.oauth_states to service_role;
```

- [ ] **Step 5: Aplicar e rodar os testes**

```powershell
npx supabase db reset
npx vitest run tests/db/oauth-states.test.ts
```

Expected: PASS (8 testes)

- [ ] **Step 6: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: tabela de oauth states com consumo atomico"
```

---

### Task 3: Autorização tipada antes do `service_role`

**Files:**
- Create: `src/lib/auth/ownership.ts`
- Test: `tests/auth/ownership.test.ts`
- Test: `tests/db/ownership-runtime.test.ts`

**Interfaces:**
- Consumes: `requireUser()`, `createServerSupabase()`, `createAdminSupabase()`, `decryptSecret()`
- Produces:
  - `type VerifiedAccount` — marca de tipo que só `assertAccountAccess` produz
  - `assertAccountAccess(accountId: string): Promise<VerifiedAccount>`
  - `getAccountSecrets(account: VerifiedAccount): Promise<AccountSecrets>`
  - `getNetworkConfig(account: VerifiedAccount): Promise<NetworkConfig | null>`
  - `class ForbiddenError extends Error`

**O que a marca de tipo é e o que ela não é.** `VerifiedAccount` é defesa de
engenharia e ergonomia: torna difícil chamar `getAccountSecrets` sem antes
passar por `assertAccountAccess`, e faz o descuido aparecer na revisão. Ela
**não** é fronteira de segurança — tipos do TypeScript desaparecem em tempo de
execução, um `as never` ou um cast qualquer a contorna, e nada disso chega ao
banco.

A garantia real vem de quatro camadas independentes, todas em runtime:

1. **Validação de posse em runtime** dentro de `assertAccountAccess`, que
   compara `owner_id` com o usuário da sessão;
2. **RLS** por `owner_id` em `reddit_accounts`, mais ausência de policy e de
   grant nas tabelas de segredo;
3. **Constraints e FKs compostas** que impedem, no próprio banco, misturar
   recursos de owners diferentes;
4. **Testes A/B** com dois usuários reais tentando alcançar os dados um do
   outro.

Se a marca de tipo for removida amanhã, nenhuma dessas quatro camadas se
enfraquece. É por isso que os testes desta task verificam a checagem de
runtime, e não apenas a assinatura.

- [ ] **Step 1: Escrever o teste falhando**

```ts
// tests/auth/ownership.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('ownership', () => {
  it('getAccountSecrets e getNetworkConfig não aceitam string', () => {
    const source = readFileSync('src/lib/auth/ownership.ts', 'utf8')
    expect(source).toMatch(/getAccountSecrets\(\s*account: VerifiedAccount/)
    expect(source).toMatch(/getNetworkConfig\(\s*account: VerifiedAccount/)
    expect(source).not.toMatch(/getAccountSecrets\(\s*\w+: string/)
    expect(source).not.toMatch(/getNetworkConfig\(\s*\w+: string/)
  })

  it('assertAccountAccess consulta com o client do usuário, não o admin', () => {
    const source = readFileSync('src/lib/auth/ownership.ts', 'utf8')
    const fn = source.slice(
      source.indexOf('export async function assertAccountAccess'),
      source.indexOf('export async function getAccountSecrets'),
    )
    expect(fn).toContain('createServerSupabase')
    expect(fn).not.toContain('createAdminSupabase')
  })

  it('é server-only', () => {
    expect(readFileSync('src/lib/auth/ownership.ts', 'utf8')).toContain(
      "import 'server-only'",
    )
  })

  it('compara owner_id em runtime, não só confia na RLS', () => {
    const source = readFileSync('src/lib/auth/ownership.ts', 'utf8')
    expect(source).toMatch(/owner_id\s*!==\s*user\.id/)
  })
})
```

```ts
// tests/db/ownership-runtime.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaB: string

// Sessão e client são injetados: é assertAccountAccess que está sob teste,
// não o Next.
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
        global: {
          headers: { Authorization: `Bearer ${clientToken.value}` },
        },
      },
    ),
}))

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`or-a-${stamp}@teste.local`)
  userB = await createTestUser(`or-b-${stamp}@teste.local`)

  const { data } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userB.id,
      reddit_user_id: `t2_or_${stamp}`,
      username: 'conta_do_b',
    })
    .select('id')
    .single()
  contaB = data!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('assertAccountAccess em runtime', () => {
  it('recusa quando o usuário A pede a conta de B', async () => {
    sessao.id = userA.id
    clientToken.value = userA.accessToken

    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )
    await expect(assertAccountAccess(contaB)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('recusa mesmo se a RLS devolvesse a linha (defesa independente)', async () => {
    // Sessão diz que é A, mas o client enxerga como B: simula uma policy
    // afrouxada por engano. A comparação explícita de owner_id precisa barrar.
    sessao.id = userA.id
    clientToken.value = userB.accessToken

    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )
    await expect(assertAccountAccess(contaB)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('aceita quando sessão e posse coincidem', async () => {
    sessao.id = userB.id
    clientToken.value = userB.accessToken

    const { assertAccountAccess } = await import('@/lib/auth/ownership')
    const conta = await assertAccountAccess(contaB)
    expect(conta.id).toBe(contaB)
    expect(conta.owner_id).toBe(userB.id)
  })

  it('recusa id inexistente', async () => {
    sessao.id = userB.id
    clientToken.value = userB.accessToken

    const { assertAccountAccess, ForbiddenError } = await import(
      '@/lib/auth/ownership'
    )
    await expect(
      assertAccountAccess('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/auth/ownership.test.ts tests/db/ownership-runtime.test.ts`
Expected: FAIL — arquivo inexistente.

- [ ] **Step 3: Implementar**

```ts
// src/lib/auth/ownership.ts
import 'server-only'
import { requireUser } from '@/lib/auth/require-user'
import { createServerSupabase } from '@/lib/supabase/server'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { decryptSecret } from '@/lib/crypto/aes-gcm'

export class ForbiddenError extends Error {
  constructor() {
    super('Conta não encontrada ou sem permissão.')
    this.name = 'ForbiddenError'
  }
}

declare const verified: unique symbol

export type RedditAccount = {
  id: string
  owner_id: string
  reddit_user_id: string
  username: string
  scopes: string[]
  status: 'connected' | 'expired' | 'disconnected' | 'revoked'
  min_interval_seconds: number
  last_submit_at: string | null
}

/**
 * Conta cuja posse já foi verificada contra a sessão atual.
 * Só assertAccountAccess produz este tipo.
 */
export type VerifiedAccount = RedditAccount & { readonly [verified]: true }

export type AccountSecrets = {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

export type NetworkConfig = {
  enabled: boolean
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username: string | null
  password: string | null
}

/**
 * Porta de entrada obrigatória para qualquer acesso a uma conta Reddit.
 *
 * Consulta com o client do usuário (RLS ativa) e confere o owner_id
 * explicitamente. Só depois disso o client administrativo entra em cena,
 * nas funções abaixo, que exigem o resultado desta.
 */
export async function assertAccountAccess(
  accountId: string,
): Promise<VerifiedAccount> {
  const user = await requireUser()
  const supabase = await createServerSupabase()

  const { data, error } = await supabase
    .from('reddit_accounts')
    .select(
      'id, owner_id, reddit_user_id, username, scopes, status, min_interval_seconds, last_submit_at',
    )
    .eq('id', accountId)
    .maybeSingle()

  if (error || !data) throw new ForbiddenError()
  // Redundante com a RLS, e de propósito: se uma policy for afrouxada por
  // engano no futuro, esta linha continua barrando.
  if (data.owner_id !== user.id) throw new ForbiddenError()

  return data as VerifiedAccount
}

function aad(column: string, accountId: string) {
  return `reddit_account_secrets:${column}:${accountId}`
}

export async function getAccountSecrets(
  account: VerifiedAccount,
): Promise<AccountSecrets> {
  const admin = createAdminSupabase()
  const { data, error } = await admin
    .from('reddit_account_secrets')
    .select('access_token_enc, refresh_token_enc, access_token_expires_at')
    .eq('reddit_account_id', account.id)
    .single()

  if (error || !data) throw new ForbiddenError()

  return {
    accessToken: decryptSecret(data.access_token_enc, aad('access_token', account.id)),
    refreshToken: decryptSecret(
      data.refresh_token_enc,
      aad('refresh_token', account.id),
    ),
    expiresAt: new Date(data.access_token_expires_at),
  }
}

export async function getNetworkConfig(
  account: VerifiedAccount,
): Promise<NetworkConfig | null> {
  const admin = createAdminSupabase()
  const { data } = await admin
    .from('reddit_account_network_configs')
    .select(
      'proxy_enabled, proxy_protocol, proxy_host, proxy_port, proxy_username, proxy_password_enc',
    )
    .eq('reddit_account_id', account.id)
    .maybeSingle()

  if (!data || !data.proxy_enabled) return null

  return {
    enabled: true,
    protocol: data.proxy_protocol as NetworkConfig['protocol'],
    host: data.proxy_host as string,
    port: data.proxy_port as number,
    username: data.proxy_username,
    password: data.proxy_password_enc
      ? decryptSecret(
          data.proxy_password_enc,
          `reddit_account_network_configs:proxy_password:${account.id}`,
        )
      : null,
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/auth/ownership.test.ts tests/db/ownership-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: autorizacao tipada antes de qualquer uso de service_role"
```

---

### Task 4: Erros do Reddit com disposição explícita

**Files:**
- Create: `src/lib/reddit/types.ts`
- Create: `src/lib/reddit/errors.ts`
- Test: `tests/reddit/errors.test.ts`

**Interfaces:**
- Produces:
  - `type Disposition = 'retryable' | 'unknown' | 'terminal'`
  - `class RedditError extends Error` com `code`, `disposition`, `httpStatus?`, `retryAfterSeconds?`, `userMessage`
  - `classifyHttp(status: number, body: unknown, hasSideEffect: boolean): RedditError | null`
  - `classifyNetwork(err: unknown, sideEffectAttempted: boolean): RedditError`

A disposição é decidida **aqui e em nenhum outro lugar**. `hasSideEffect` distingue `/api/submit` de uma leitura: um 5xx numa leitura é retentável; num POST que pode ter criado a publicação, não é.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/reddit/errors.test.ts
import { describe, expect, it } from 'vitest'
import { classifyHttp, classifyNetwork, RedditError } from '@/lib/reddit/errors'

describe('classifyHttp em requisição de efeito', () => {
  const efeito = true

  it('200 sem erros não gera erro', () => {
    expect(classifyHttp(200, { json: { errors: [] } }, efeito)).toBeNull()
  })

  it('200 com json.errors é terminal', () => {
    const e = classifyHttp(
      200,
      { json: { errors: [['NO_TEXT', 'we need something here', 'title']] } },
      efeito,
    )
    expect(e).toBeInstanceOf(RedditError)
    expect(e!.disposition).toBe('terminal')
  })

  it('429 é retryable', () => {
    const e = classifyHttp(429, {}, efeito)
    expect(e!.disposition).toBe('retryable')
    expect(e!.code).toBe('RATE_LIMITED')
  })

  it.each([500, 502, 503, 504])(
    '%i é unknown em requisição de efeito',
    (status) => {
      const e = classifyHttp(status, {}, efeito)
      expect(e!.disposition).toBe('unknown')
    },
  )

  it('403 é terminal e fala de permissão', () => {
    const e = classifyHttp(403, {}, efeito)
    expect(e!.disposition).toBe('terminal')
    expect(e!.code).toBe('NO_PERMISSION')
    expect(e!.userMessage).toMatch(/permiss/i)
  })

  it('404 é terminal', () => {
    expect(classifyHttp(404, {}, efeito)!.disposition).toBe('terminal')
  })

  it('401 é terminal e indica token inválido', () => {
    const e = classifyHttp(401, {}, efeito)
    expect(e!.code).toBe('TOKEN_INVALID')
    expect(e!.disposition).toBe('terminal')
  })
})

describe('classifyHttp em requisição de leitura', () => {
  const leitura = false

  it.each([500, 502, 503, 504])('%i é retryable em leitura', (status) => {
    expect(classifyHttp(status, {}, leitura)!.disposition).toBe('retryable')
  })

  it('429 continua retryable', () => {
    expect(classifyHttp(429, {}, leitura)!.disposition).toBe('retryable')
  })
})

describe('classifyNetwork', () => {
  it('DNS antes do envio é retryable', () => {
    const e = classifyNetwork(
      Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
  })

  it('conexão recusada antes do envio é retryable', () => {
    const e = classifyNetwork(
      Object.assign(new Error('recusada'), { code: 'ECONNREFUSED' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
  })

  it('timeout de conexão antes do envio é retryable', () => {
    const e = classifyNetwork(
      Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
  })

  it('reset APÓS o envio é unknown', () => {
    const e = classifyNetwork(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      true,
    )
    expect(e.disposition).toBe('unknown')
  })

  it('timeout de headers APÓS o envio é unknown', () => {
    const e = classifyNetwork(
      Object.assign(new Error('headers'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
      true,
    )
    expect(e.disposition).toBe('unknown')
  })

  it('mesmo um ECONNREFUSED marcado como pós-envio vira unknown', () => {
    // Conservador de propósito: na dúvida, revisão humana em vez de duplicata.
    const e = classifyNetwork(
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      true,
    )
    expect(e.disposition).toBe('unknown')
  })

  it('falha de proxy é retryable quando nada foi enviado', () => {
    const e = classifyNetwork(
      Object.assign(new Error('proxy'), { code: 'UND_ERR_PROXY' }),
      false,
    )
    expect(e.disposition).toBe('retryable')
    expect(e.code).toBe('PROXY_UNAVAILABLE')
  })
})

describe('mensagens ao usuário', () => {
  it('toda mensagem é legível e em português, sem jargão de infraestrutura', () => {
    const erros = [
      classifyHttp(403, {}, true)!,
      classifyHttp(429, {}, true)!,
      classifyHttp(500, {}, true)!,
      classifyNetwork(Object.assign(new Error(''), { code: 'ENOTFOUND' }), false),
    ]
    for (const e of erros) {
      expect(e.userMessage.length).toBeGreaterThan(10)
      expect(e.userMessage).not.toMatch(/undefined|null|ENOTFOUND|ECONN/)
    }
  })

  it('nenhuma mensagem vaza token', () => {
    const e = classifyHttp(401, { access_token: 'AT-123' }, true)!
    expect(JSON.stringify(e.userMessage)).not.toContain('AT-123')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/reddit/errors.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar os tipos**

```ts
// src/lib/reddit/types.ts
export type RedditTokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope: string
}

export type RedditIdentity = {
  id: string
  name: string
}

export type RedditApiEnvelope = {
  json?: {
    errors?: [string, string, string?][]
    data?: Record<string, unknown>
  }
}

export type RateLimitSnapshot = {
  used: number | null
  remaining: number | null
  resetSeconds: number | null
}
```

- [ ] **Step 4: Implementar os erros**

```ts
// src/lib/reddit/errors.ts
import type { RedditApiEnvelope } from './types'

export type Disposition = 'retryable' | 'unknown' | 'terminal'

export class RedditError extends Error {
  readonly code: string
  readonly disposition: Disposition
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
  readonly userMessage: string

  constructor(init: {
    code: string
    disposition: Disposition
    userMessage: string
    httpStatus?: number
    retryAfterSeconds?: number
  }) {
    super(`${init.code} (${init.disposition})`)
    this.name = 'RedditError'
    this.code = init.code
    this.disposition = init.disposition
    this.httpStatus = init.httpStatus
    this.retryAfterSeconds = init.retryAfterSeconds
    this.userMessage = init.userMessage
  }
}

/**
 * Classifica uma resposta HTTP do Reddit.
 *
 * `hasSideEffect` marca requisições que podem ter alterado estado
 * (/api/submit, /api/comment, selectflair). Para elas, qualquer 5xx é
 * ambíguo: não existe documentação oficial do Reddit garantindo que um POST
 * respondido com 5xx não produziu efeito, e um gateway pode falhar depois do
 * upstream processar. Preferimos revisão humana a uma publicação duplicada.
 */
export function classifyHttp(
  status: number,
  body: unknown,
  hasSideEffect: boolean,
): RedditError | null {
  if (status === 401) {
    return new RedditError({
      code: 'TOKEN_INVALID',
      disposition: 'terminal',
      httpStatus: status,
      userMessage:
        'A autorização desta conta expirou. Reconecte a conta para continuar.',
    })
  }

  if (status === 403) {
    return new RedditError({
      code: 'NO_PERMISSION',
      disposition: 'terminal',
      httpStatus: status,
      userMessage:
        'Sua conta não possui mais permissão para essa ação nessa comunidade.',
    })
  }

  if (status === 404) {
    return new RedditError({
      code: 'NOT_FOUND',
      disposition: 'terminal',
      httpStatus: status,
      userMessage: 'A comunidade ou o conteúdo informado não foi encontrado.',
    })
  }

  if (status === 429) {
    return new RedditError({
      code: 'RATE_LIMITED',
      disposition: 'retryable',
      httpStatus: status,
      userMessage:
        'O Reddit pediu para aguardar antes de novas requisições. A ação será retomada automaticamente.',
    })
  }

  if (status >= 500) {
    return new RedditError({
      code: hasSideEffect ? 'OUTCOME_UNKNOWN' : 'REDDIT_UNAVAILABLE',
      disposition: hasSideEffect ? 'unknown' : 'retryable',
      httpStatus: status,
      userMessage: hasSideEffect
        ? 'O Reddit não confirmou o resultado desta ação. Ela precisa de revisão manual antes de qualquer nova tentativa.'
        : 'O Reddit está indisponível no momento. Vamos tentar de novo.',
    })
  }

  if (status >= 400) {
    return new RedditError({
      code: 'BAD_REQUEST',
      disposition: 'terminal',
      httpStatus: status,
      userMessage: 'O Reddit recusou os dados enviados.',
    })
  }

  // 2xx ainda pode carregar erro no corpo: o Reddit responde 200 com
  // json.errors quando rejeita o conteúdo.
  const envelope = body as RedditApiEnvelope
  const errors = envelope?.json?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const [code, message] = errors[0]
    return new RedditError({
      code: `CONTENT_REJECTED:${code}`,
      disposition: 'terminal',
      httpStatus: status,
      userMessage: `O Reddit recusou a publicação: ${message}`,
    })
  }

  return null
}

const PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UND_ERR_PROXY',
])

/**
 * Classifica uma falha de rede.
 *
 * `sideEffectAttempted` é verdadeiro a partir do momento em que a requisição
 * de efeito foi entregue à camada de transporte. Depois disso, nenhum erro de
 * rede é retentável: não há como saber se o Reddit processou o pedido.
 */
export function classifyNetwork(
  err: unknown,
  sideEffectAttempted: boolean,
): RedditError {
  const code = (err as { code?: string })?.code ?? 'NETWORK_ERROR'
  const isProxy = code === 'UND_ERR_PROXY'

  if (sideEffectAttempted) {
    return new RedditError({
      code: 'OUTCOME_UNKNOWN',
      disposition: 'unknown',
      userMessage:
        'A conexão caiu depois do envio e o resultado é desconhecido. Esta ação precisa de revisão manual.',
    })
  }

  if (PRE_SEND_CODES.has(code)) {
    return new RedditError({
      code: isProxy ? 'PROXY_UNAVAILABLE' : 'NETWORK_ERROR',
      disposition: 'retryable',
      userMessage: isProxy
        ? 'A configuração de rede desta conta está indisponível. Vamos tentar de novo.'
        : 'Não foi possível alcançar o Reddit. Vamos tentar de novo.',
    })
  }

  // Código desconhecido e requisição sem efeito: retentar é seguro.
  return new RedditError({
    code: 'NETWORK_ERROR',
    disposition: 'retryable',
    userMessage: 'Falha de rede ao falar com o Reddit. Vamos tentar de novo.',
  })
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/reddit/errors.test.ts`
Expected: PASS

- [ ] **Step 6: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: erros do reddit com disposicao explicita"
```

---

### Task 5: Cliente HTTP do Reddit

**Files:**
- Create: `src/lib/reddit/ratelimit.ts`
- Create: `src/lib/reddit/client.ts`
- Test: `tests/reddit/client.test.ts`

**Interfaces:**
- Consumes: `RedditError`, `classifyHttp`, `classifyNetwork`, `getRedditEnv()`
- Produces:
  - `readRateLimit(headers): RateLimitSnapshot`
  - `createRedditClient(opts: { accessToken: string; dispatcher?: Dispatcher }): RedditClient`
  - `RedditClient.request<T>(opts: { path: string; method?: 'GET' | 'POST'; form?: Record<string,string>; query?: Record<string,string>; hasSideEffect?: boolean }): Promise<{ data: T; rateLimit: RateLimitSnapshot }>`

O `dispatcher` é injetável justamente para os testes poderem passar um `MockAgent` — nenhuma requisição real sai da máquina.

- [ ] **Step 1: Instalar o undici**

```powershell
npm install undici@^8.10.0
```

- [ ] **Step 2: Escrever os testes falhando**

```ts
// tests/reddit/client.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { createRedditClient } from '@/lib/reddit/client'
import { readRateLimit } from '@/lib/reddit/ratelimit'
import { RedditError } from '@/lib/reddit/errors'

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

function pool() {
  return agent.get('https://oauth.reddit.com')
}

describe('createRedditClient', () => {
  it('envia Authorization e User-Agent obrigatórios', async () => {
    let capturados: Record<string, unknown> = {}
    pool()
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(200, (opts) => {
        capturados = opts.headers as Record<string, unknown>
        return { id: 't2_1', name: 'conta01' }
      })

    const client = createRedditClient({
      accessToken: 'AT-123',
      dispatcher: agent,
    })
    await client.request({ path: '/api/v1/me' })

    expect(capturados['authorization']).toBe('bearer AT-123')
    expect(capturados['user-agent']).toContain('reddit-scheduler')
  })

  it('devolve o corpo já convertido', async () => {
    pool()
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(200, { id: 't2_1', name: 'conta01' })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    const { data } = await client.request<{ name: string }>({ path: '/api/v1/me' })
    expect(data.name).toBe('conta01')
  })

  it('serializa form como application/x-www-form-urlencoded', async () => {
    let corpo = ''
    pool()
      .intercept({ path: '/api/submit', method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return { json: { errors: [] } }
      })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await client.request({
      path: '/api/submit',
      method: 'POST',
      form: { kind: 'link', title: 'Olá mundo', sr: 'teste' },
      hasSideEffect: true,
    })

    expect(corpo).toContain('kind=link')
    expect(corpo).toContain('title=Ol%C3%A1+mundo')
  })

  it('lê os headers de rate limit', async () => {
    pool()
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(200, { id: 't2_1' }, {
        headers: {
          'x-ratelimit-used': '12',
          'x-ratelimit-remaining': '88',
          'x-ratelimit-reset': '340',
        },
      })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    const { rateLimit } = await client.request({ path: '/api/v1/me' })
    expect(rateLimit).toEqual({ used: 12, remaining: 88, resetSeconds: 340 })
  })

  it('converte 429 em RedditError retryable com Retry-After', async () => {
    pool()
      .intercept({ path: '/api/v1/me', method: 'GET' })
      .reply(429, {}, { headers: { 'retry-after': '17' } })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      disposition: 'retryable',
      retryAfterSeconds: 17,
    })
  })

  it('5xx em requisição de efeito vira unknown', async () => {
    pool().intercept({ path: '/api/submit', method: 'POST' }).reply(503, {})

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(
      client.request({
        path: '/api/submit',
        method: 'POST',
        form: { kind: 'self' },
        hasSideEffect: true,
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', disposition: 'unknown' })
  })

  it('5xx em leitura vira retryable', async () => {
    pool().intercept({ path: '/api/v1/me', method: 'GET' }).reply(503, {})

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      disposition: 'retryable',
    })
  })

  it('200 com json.errors vira erro terminal', async () => {
    pool()
      .intercept({ path: '/api/submit', method: 'POST' })
      .reply(200, { json: { errors: [['SUBREDDIT_NOTALLOWED', 'não permitido']] } })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    await expect(
      client.request({
        path: '/api/submit',
        method: 'POST',
        form: {},
        hasSideEffect: true,
      }),
    ).rejects.toMatchObject({ disposition: 'terminal' })
  })

  it('erro do cliente nunca carrega o token', async () => {
    pool().intercept({ path: '/api/v1/me', method: 'GET' }).reply(403, {})

    const client = createRedditClient({
      accessToken: 'AT-SUPER-SECRETO',
      dispatcher: agent,
    })
    try {
      await client.request({ path: '/api/v1/me' })
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect(e).toBeInstanceOf(RedditError)
      expect(JSON.stringify(e)).not.toContain('AT-SUPER-SECRETO')
      expect((e as Error).stack ?? '').not.toContain('AT-SUPER-SECRETO')
    }
  })

  it('monta a query string a partir de query', async () => {
    pool()
      .intercept({ path: '/subreddits/mine/moderator?limit=100', method: 'GET' })
      .reply(200, { data: { children: [] } })

    const client = createRedditClient({ accessToken: 'AT', dispatcher: agent })
    const { data } = await client.request<{ data: unknown }>({
      path: '/subreddits/mine/moderator',
      query: { limit: '100' },
    })
    expect(data).toBeDefined()
  })
})

describe('readRateLimit', () => {
  it('devolve nulos quando os headers não vêm', () => {
    expect(readRateLimit({})).toEqual({
      used: null,
      remaining: null,
      resetSeconds: null,
    })
  })

  it('ignora valores não numéricos', () => {
    expect(readRateLimit({ 'x-ratelimit-remaining': 'abc' }).remaining).toBeNull()
  })

  it('aceita valores fracionários que o Reddit às vezes envia', () => {
    expect(readRateLimit({ 'x-ratelimit-remaining': '95.0' }).remaining).toBe(95)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/reddit/client.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 4: Implementar a leitura de rate limit**

```ts
// src/lib/reddit/ratelimit.ts
import type { RateLimitSnapshot } from './types'

function num(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Os headers X-Ratelimit-* são a fonte operacional de verdade sobre o
 * orçamento de requisições — mais confiável que qualquer limite documentado.
 */
export function readRateLimit(
  headers: Record<string, unknown>,
): RateLimitSnapshot {
  return {
    used: num(headers['x-ratelimit-used']),
    remaining: num(headers['x-ratelimit-remaining']),
    resetSeconds: num(headers['x-ratelimit-reset']),
  }
}
```

- [ ] **Step 5: Implementar o cliente**

```ts
// src/lib/reddit/client.ts
import { fetch, type Dispatcher } from 'undici'
import { getRedditEnv } from '@/lib/config/env'
import { classifyHttp, classifyNetwork, RedditError } from './errors'
import { readRateLimit } from './ratelimit'
import type { RateLimitSnapshot } from './types'

const API_BASE = 'https://oauth.reddit.com'

export type RedditRequest = {
  path: string
  method?: 'GET' | 'POST'
  form?: Record<string, string>
  query?: Record<string, string>
  /** Marque true em /api/submit, /api/comment e selectflair. */
  hasSideEffect?: boolean
}

export type RedditClient = {
  request<T>(req: RedditRequest): Promise<{ data: T; rateLimit: RateLimitSnapshot }>
}

export function createRedditClient(opts: {
  accessToken: string
  dispatcher?: Dispatcher
}): RedditClient {
  return {
    async request<T>(req: RedditRequest) {
      const { REDDIT_USER_AGENT } = getRedditEnv()
      const method = req.method ?? 'GET'
      const hasSideEffect = req.hasSideEffect ?? false

      const url = new URL(API_BASE + req.path)
      for (const [k, v] of Object.entries(req.query ?? {})) {
        url.searchParams.set(k, v)
      }
      // O Reddit devolve HTML de "página" se não pedirmos JSON explicitamente.
      url.searchParams.set('raw_json', '1')

      const headers: Record<string, string> = {
        authorization: `bearer ${opts.accessToken}`,
        'user-agent': REDDIT_USER_AGENT,
        accept: 'application/json',
      }

      let body: string | undefined
      if (req.form) {
        body = new URLSearchParams({ ...req.form, api_type: 'json' }).toString()
        headers['content-type'] = 'application/x-www-form-urlencoded'
      }

      // A partir daqui a requisição foi entregue ao transporte: se ela tinha
      // efeito colateral, nenhuma falha posterior é retentável.
      let sideEffectAttempted = false

      let response
      try {
        sideEffectAttempted = hasSideEffect
        response = await fetch(url, {
          method,
          headers,
          body,
          dispatcher: opts.dispatcher,
        })
      } catch (err) {
        throw classifyNetwork(err, sideEffectAttempted)
      }

      const rawHeaders: Record<string, unknown> = {}
      response.headers.forEach((value, key) => {
        rawHeaders[key.toLowerCase()] = value
      })
      const rateLimit = readRateLimit(rawHeaders)

      let payload: unknown = null
      try {
        const text = await response.text()
        payload = text ? JSON.parse(text) : null
      } catch {
        // Corpo ilegível: se a requisição tinha efeito, o resultado é incerto.
        if (hasSideEffect) {
          throw new RedditError({
            code: 'OUTCOME_UNKNOWN',
            disposition: 'unknown',
            httpStatus: response.status,
            userMessage:
              'O Reddit devolveu uma resposta ilegível. Esta ação precisa de revisão manual.',
          })
        }
        payload = null
      }

      const error = classifyHttp(response.status, payload, hasSideEffect)
      if (error) {
        const retryAfter = Number(rawHeaders['retry-after'])
        if (Number.isFinite(retryAfter)) {
          throw new RedditError({
            code: error.code,
            disposition: error.disposition,
            httpStatus: error.httpStatus,
            userMessage: error.userMessage,
            retryAfterSeconds: Math.trunc(retryAfter),
          })
        }
        throw error
      }

      return { data: payload as T, rateLimit }
    },
  }
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run tests/reddit/client.test.ts`
Expected: PASS

- [ ] **Step 7: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: cliente http do reddit com rate limit e erros tipados"
```

---

### Task 6: Fluxo OAuth — state, troca de code e refresh

**Files:**
- Create: `src/lib/reddit/auth.ts`
- Test: `tests/reddit/auth.test.ts`

**Interfaces:**
- Consumes: `getRedditEnv()`, `createAdminSupabase()`, `RedditError`
- Produces:
  - `REDDIT_SCOPES: readonly string[]`
  - `buildAuthorizeUrl(state: string): string`
  - `createOAuthState(ownerId: string): Promise<{ value: string; cookie: {...} }>`
  - `consumeOAuthState(value: string, ownerId: string): Promise<void>` — lança `OAuthStateError`
  - `exchangeCode(code: string, dispatcher?): Promise<RedditTokenResponse>`
  - `refreshAccessToken(refreshToken: string, dispatcher?): Promise<RedditTokenResponse>`
  - `fetchIdentity(accessToken: string, dispatcher?): Promise<RedditIdentity>`

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/reddit/auth.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  REDDIT_SCOPES,
} from '@/lib/reddit/auth'

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

describe('buildAuthorizeUrl', () => {
  it('monta a URL oficial com todos os parâmetros exigidos', () => {
    const url = new URL(buildAuthorizeUrl('STATE-123'))
    expect(url.origin + url.pathname).toBe('https://www.reddit.com/api/v1/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid-fake')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('STATE-123')
    expect(url.searchParams.get('duration')).toBe('permanent')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/reddit/callback',
    )
  })

  it('pede exatamente os escopos necessários', () => {
    const url = new URL(buildAuthorizeUrl('S'))
    const scopes = url.searchParams.get('scope')!.split(' ')
    expect(scopes.sort()).toEqual([...REDDIT_SCOPES].sort())
    expect(scopes).toContain('identity')
    expect(scopes).toContain('submit')
    expect(scopes).toContain('mysubreddits')
    expect(scopes).toContain('flair')
  })

  it('nunca inclui o client_secret na URL', () => {
    expect(buildAuthorizeUrl('S')).not.toContain('csecret-fake')
  })
})

describe('exchangeCode', () => {
  function tokenPool() {
    return agent.get('https://www.reddit.com')
  }

  it('usa HTTP Basic com client_id e client_secret', async () => {
    let auth = ''
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, (opts) => {
        auth = String((opts.headers as Record<string, string>)['authorization'])
        return {
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
          scope: 'identity submit',
          token_type: 'bearer',
        }
      })

    await exchangeCode('CODE-1', agent)

    const esperado =
      'Basic ' + Buffer.from('cid-fake:csecret-fake').toString('base64')
    expect(auth).toBe(esperado)
  })

  it('envia grant_type=authorization_code com code e redirect_uri', async () => {
    let corpo = ''
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return {
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
          scope: 'identity',
          token_type: 'bearer',
        }
      })

    await exchangeCode('CODE-1', agent)
    expect(corpo).toContain('grant_type=authorization_code')
    expect(corpo).toContain('code=CODE-1')
    expect(corpo).toContain('redirect_uri=')
  })

  it('devolve os tokens', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT-1',
        refresh_token: 'RT-1',
        expires_in: 3600,
        scope: 'identity submit',
        token_type: 'bearer',
      })

    const token = await exchangeCode('CODE-1', agent)
    expect(token.access_token).toBe('AT-1')
    expect(token.refresh_token).toBe('RT-1')
  })

  it('erro do Reddit vira RedditError terminal sem vazar o secret', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(401, { error: 'invalid_grant' })

    try {
      await exchangeCode('CODE-RUIM', agent)
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as { disposition: string }).disposition).toBe('terminal')
      expect(JSON.stringify(e)).not.toContain('csecret-fake')
    }
  })

  it('resposta sem refresh_token é rejeitada', async () => {
    tokenPool()
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT',
        expires_in: 3600,
        scope: 'identity',
        token_type: 'bearer',
      })

    await expect(exchangeCode('CODE-1', agent)).rejects.toMatchObject({
      code: 'NO_REFRESH_TOKEN',
    })
  })
})

describe('refreshAccessToken', () => {
  it('envia grant_type=refresh_token', async () => {
    let corpo = ''
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, (opts) => {
        corpo = String(opts.body)
        return {
          access_token: 'AT-NOVO',
          expires_in: 3600,
          scope: 'identity',
          token_type: 'bearer',
        }
      })

    const token = await refreshAccessToken('RT-1', agent)
    expect(corpo).toContain('grant_type=refresh_token')
    expect(corpo).toContain('refresh_token=RT-1')
    expect(token.access_token).toBe('AT-NOVO')
  })

  it('refresh token inválido vira erro terminal identificável', async () => {
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(400, { error: 'invalid_grant' })

    await expect(refreshAccessToken('RT-RUIM', agent)).rejects.toMatchObject({
      code: 'REFRESH_INVALID',
      disposition: 'terminal',
    })
  })

  it('nenhum erro de refresh carrega o refresh token', async () => {
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(400, { error: 'invalid_grant' })

    try {
      await refreshAccessToken('RT-SUPER-SECRETO', agent)
    } catch (e) {
      expect(JSON.stringify(e)).not.toContain('RT-SUPER-SECRETO')
      expect((e as Error).message).not.toContain('RT-SUPER-SECRETO')
    }
  })
})
```

E os testes de state, que precisam do banco:

```ts
// tests/db/oauth-flow.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupTestUsers, createTestUser } from './helpers'
import { consumeOAuthState, createOAuthState, OAuthStateError } from '@/lib/reddit/auth'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`of-a-${stamp}@teste.local`)
  userB = await createTestUser(`of-b-${stamp}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('state do OAuth', () => {
  it('gera valor com entropia de 32 bytes', async () => {
    const { value } = await createOAuthState(userA.id)
    expect(Buffer.from(value, 'base64url')).toHaveLength(32)
  })

  it('o cookie é httpOnly, SameSite=Lax e de vida curta', async () => {
    const { cookie } = await createOAuthState(userA.id)
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('lax')
    expect(cookie.maxAge).toBeLessThanOrEqual(600)
  })

  it('dois states seguidos nunca coincidem', async () => {
    const a = await createOAuthState(userA.id)
    const b = await createOAuthState(userA.id)
    expect(a.value).not.toBe(b.value)
  })

  it('consome um state válido do próprio usuário', async () => {
    const { value } = await createOAuthState(userA.id)
    await expect(consumeOAuthState(value, userA.id)).resolves.toBeUndefined()
  })

  it('recusa replay do mesmo state', async () => {
    const { value } = await createOAuthState(userA.id)
    await consumeOAuthState(value, userA.id)
    await expect(consumeOAuthState(value, userA.id)).rejects.toBeInstanceOf(
      OAuthStateError,
    )
  })

  it('recusa state pertencente a outra sessão', async () => {
    const { value } = await createOAuthState(userA.id)
    await expect(consumeOAuthState(value, userB.id)).rejects.toBeInstanceOf(
      OAuthStateError,
    )
  })

  it('recusa state inexistente', async () => {
    await expect(
      consumeOAuthState('state-que-nunca-existiu', userA.id),
    ).rejects.toBeInstanceOf(OAuthStateError)
  })

  it('um state recusado por owner errado não pode ser reusado pelo dono', async () => {
    const { value } = await createOAuthState(userA.id)
    await expect(consumeOAuthState(value, userB.id)).rejects.toThrow()
    // A tentativa falha sem consumir: o dono legítimo ainda consegue usar.
    await expect(consumeOAuthState(value, userA.id)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/reddit/auth.test.ts tests/db/oauth-flow.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// src/lib/reddit/auth.ts
import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { fetch, type Dispatcher } from 'undici'
import { getRedditEnv } from '@/lib/config/env'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { RedditError } from './errors'
import type { RedditIdentity, RedditTokenResponse } from './types'

const AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize'
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const STATE_TTL_SECONDS = 600

export const REDDIT_SCOPES = [
  'identity',
  'mysubreddits',
  'submit',
  'read',
  'flair',
  'edit',
  'history',
] as const

export const STATE_COOKIE = 'reddit_oauth_state'

export class OAuthStateError extends Error {
  constructor() {
    // Mensagem única para todos os motivos: não informa a quem tenta adivinhar
    // se o state existia, expirou ou pertencia a outra sessão.
    super('Não foi possível validar a solicitação. Tente conectar novamente.')
    this.name = 'OAuthStateError'
  }
}

const hashState = (value: string) =>
  createHash('sha256').update(value).digest('hex')

export function buildAuthorizeUrl(state: string): string {
  const env = getRedditEnv()
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', env.REDDIT_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', env.REDDIT_REDIRECT_URI)
  // permanent é o que faz o Reddit devolver refresh token.
  url.searchParams.set('duration', 'permanent')
  url.searchParams.set('scope', REDDIT_SCOPES.join(' '))
  return url.toString()
}

export async function createOAuthState(ownerId: string) {
  const value = randomBytes(32).toString('base64url')
  const admin = createAdminSupabase()

  const { error } = await admin.from('oauth_states').insert({
    owner_id: ownerId,
    state_hash: hashState(value),
    expires_at: new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString(),
  })
  if (error) throw new OAuthStateError()

  return {
    value,
    cookie: {
      name: STATE_COOKIE,
      value,
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/api/reddit',
      maxAge: STATE_TTL_SECONDS,
    },
  }
}

/**
 * Consome o state. O UPDATE condicional é a própria trava contra replay:
 * a segunda tentativa não encontra linha para atualizar.
 */
export async function consumeOAuthState(
  value: string,
  ownerId: string,
): Promise<void> {
  const admin = createAdminSupabase()
  const { data, error } = await admin
    .from('oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state_hash', hashState(value))
    .eq('owner_id', ownerId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')

  if (error || !data || data.length !== 1) throw new OAuthStateError()
}

function basicAuth(): string {
  const env = getRedditEnv()
  const raw = `${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`
  return 'Basic ' + Buffer.from(raw).toString('base64')
}

async function requestToken(
  form: Record<string, string>,
  invalidCode: string,
  dispatcher?: Dispatcher,
): Promise<RedditTokenResponse> {
  const env = getRedditEnv()
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuth(),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': env.REDDIT_USER_AGENT,
    },
    body: new URLSearchParams(form).toString(),
    dispatcher,
  })

  if (!response.ok) {
    // O corpo é descartado de propósito: pode ecoar o que enviamos.
    throw new RedditError({
      code: invalidCode,
      disposition: 'terminal',
      httpStatus: response.status,
      userMessage:
        'O Reddit recusou a autorização desta conta. Conecte a conta novamente.',
    })
  }

  return (await response.json()) as RedditTokenResponse
}

export async function exchangeCode(
  code: string,
  dispatcher?: Dispatcher,
): Promise<RedditTokenResponse> {
  const env = getRedditEnv()
  const token = await requestToken(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.REDDIT_REDIRECT_URI,
    },
    'OAUTH_EXCHANGE_FAILED',
    dispatcher,
  )

  if (!token.refresh_token) {
    throw new RedditError({
      code: 'NO_REFRESH_TOKEN',
      disposition: 'terminal',
      userMessage:
        'O Reddit não devolveu autorização permanente. Refaça a conexão da conta.',
    })
  }

  return token
}

export async function refreshAccessToken(
  refreshToken: string,
  dispatcher?: Dispatcher,
): Promise<RedditTokenResponse> {
  return requestToken(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    'REFRESH_INVALID',
    dispatcher,
  )
}

export async function fetchIdentity(
  accessToken: string,
  dispatcher?: Dispatcher,
): Promise<RedditIdentity> {
  const env = getRedditEnv()
  const response = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: {
      authorization: `bearer ${accessToken}`,
      'user-agent': env.REDDIT_USER_AGENT,
    },
    dispatcher,
  })

  if (!response.ok) {
    throw new RedditError({
      code: 'IDENTITY_FAILED',
      disposition: 'terminal',
      httpStatus: response.status,
      userMessage: 'Não foi possível confirmar a identidade da conta no Reddit.',
    })
  }

  const me = (await response.json()) as { id: string; name: string }
  return { id: me.id, name: me.name }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/reddit/auth.test.ts tests/db/oauth-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: fluxo oauth do reddit com state de uso unico"
```

---

### Task 7: `RedditClientFactory` — refresh automático e dispatcher por conta

**Files:**
- Create: `src/lib/reddit/reddit-client-factory.ts`
- Test: `tests/reddit/factory.test.ts`
- Test: `tests/db/factory-refresh.test.ts`

**Interfaces:**
- Consumes: `VerifiedAccount`, `getAccountSecrets`, `getNetworkConfig`, `refreshAccessToken`, `createRedditClient`
- Produces:
  - `buildProxyUrl(config: NetworkConfig): string`
  - `createDispatcherFor(config: NetworkConfig | null): Dispatcher | undefined`
  - `getRedditClient(account: VerifiedAccount, opts?): Promise<RedditClient>`
  - `persistTokens(accountId, token): Promise<void>`

- [ ] **Step 1: Escrever os testes de unidade falhando**

```ts
// tests/reddit/factory.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { buildProxyUrl, createDispatcherFor } from '@/lib/reddit/reddit-client-factory'
import { sanitize } from '@/lib/logging/sanitize'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')
})

const base = {
  enabled: true as const,
  host: 'proxy.exemplo.com',
  port: 1080,
  username: 'usuario',
  password: 'senha-secreta',
}

describe('buildProxyUrl', () => {
  it('monta URL socks5 com credenciais', () => {
    const url = buildProxyUrl({ ...base, protocol: 'socks5' })
    expect(url).toBe('socks5://usuario:senha-secreta@proxy.exemplo.com:1080')
  })

  it('monta URL http sem credenciais quando não há usuário', () => {
    const url = buildProxyUrl({
      ...base,
      protocol: 'http',
      username: null,
      password: null,
    })
    expect(url).toBe('http://proxy.exemplo.com:1080')
  })

  it('escapa caracteres especiais na senha', () => {
    const url = buildProxyUrl({
      ...base,
      protocol: 'http',
      password: 'a@b:c/d',
    })
    expect(url).toContain('a%40b%3Ac%2Fd')
    expect(url).toContain('@proxy.exemplo.com:1080')
  })

  it('a URL montada é redigida pelo sanitizador de logs', () => {
    const url = buildProxyUrl({ ...base, protocol: 'socks5' })
    const seguro = sanitize({ note: `conectando em ${url}` }) as { note: string }
    expect(seguro.note).not.toContain('senha-secreta')
    expect(seguro.note).not.toContain('usuario')
  })
})

describe('createDispatcherFor', () => {
  it('devolve undefined quando não há configuração de rede', () => {
    expect(createDispatcherFor(null)).toBeUndefined()
  })

  it.each(['http', 'https', 'socks5'] as const)(
    'constrói dispatcher para %s',
    (protocol) => {
      const d = createDispatcherFor({ ...base, protocol })
      expect(d).toBeDefined()
    },
  )

  it('não expõe a senha em propriedades enumeráveis do dispatcher', () => {
    const d = createDispatcherFor({ ...base, protocol: 'http' })
    expect(JSON.stringify(d ?? {})).not.toContain('senha-secreta')
  })
})
```

E o teste do refresh, contra o banco:

```ts
// tests/db/factory-refresh.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockAgent } from 'undici'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { encryptSecret } from '@/lib/crypto/aes-gcm'

let userA: { id: string; accessToken: string }
let accountId: string
let agent: MockAgent

async function seedAccount(expiresInMs: number) {
  const { data } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_${randomBytes(4).toString('hex')}`,
      username: 'conta_refresh',
      scopes: ['identity', 'submit'],
    })
    .select('id')
    .single()

  const id = data!.id as string
  await adminClient().from('reddit_account_secrets').insert({
    reddit_account_id: id,
    owner_id: userA.id,
    access_token_enc: encryptSecret(
      'AT-ANTIGO',
      `reddit_account_secrets:access_token:${id}`,
    ),
    refresh_token_enc: encryptSecret(
      'RT-1',
      `reddit_account_secrets:refresh_token:${id}`,
    ),
    access_token_expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  })
  return id
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  userA = await createTestUser(`fr-${Date.now()}@teste.local`)
})

beforeEach(() => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  agent = new MockAgent()
  agent.disableNetConnect()
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('refresh automático', () => {
  it('não renova quando o token ainda tem folga', async () => {
    accountId = await seedAccount(3600_000)
    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    // Nenhum intercept registrado: qualquer chamada de rede falharia o teste.
    await getRedditClient(
      { id: accountId, owner_id: userA.id } as never,
      { dispatcher: agent, skipOwnershipCheck: true },
    )
    expect(agent.pendingInterceptors()).toHaveLength(0)
  })

  it('renova quando faltam menos de 120s e persiste o token novo cifrado', async () => {
    accountId = await seedAccount(60_000)
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT-NOVO',
        expires_in: 3600,
        scope: 'identity',
        token_type: 'bearer',
      })

    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    await getRedditClient(
      { id: accountId, owner_id: userA.id } as never,
      { dispatcher: agent, skipOwnershipCheck: true },
    )

    const { data } = await adminClient()
      .from('reddit_account_secrets')
      .select('access_token_enc')
      .eq('reddit_account_id', accountId)
      .single()

    const armazenado = data!.access_token_enc

    // O prefixo v1. diz apenas qual é o formato do envelope — sozinho ele não
    // prova cifragem nenhuma. As três verificações abaixo é que provam:
    // 1. o valor armazenado difere do texto claro;
    expect(armazenado).not.toBe('AT-NOVO')
    // 2. o texto claro não aparece em lugar nenhum do valor armazenado,
    //    nem em base64, nem em hex;
    expect(armazenado).not.toContain('AT-NOVO')
    expect(armazenado).not.toContain(Buffer.from('AT-NOVO').toString('base64'))
    expect(armazenado).not.toContain(
      Buffer.from('AT-NOVO').toString('base64url'),
    )
    expect(armazenado).not.toContain(Buffer.from('AT-NOVO').toString('hex'))
    // 3. e o decrypt no servidor recupera exatamente o valor original.
    const { decryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(
      decryptSecret(
        armazenado,
        `reddit_account_secrets:access_token:${accountId}`,
      ),
    ).toBe('AT-NOVO')
  })

  it('o refresh token guardado também é recuperável e nunca fica em claro', async () => {
    accountId = await seedAccount(3600_000)

    const { data } = await adminClient()
      .from('reddit_account_secrets')
      .select('refresh_token_enc')
      .eq('reddit_account_id', accountId)
      .single()

    const armazenado = data!.refresh_token_enc
    expect(armazenado).not.toBe('RT-1')
    expect(armazenado).not.toContain('RT-1')

    const { decryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(
      decryptSecret(
        armazenado,
        `reddit_account_secrets:refresh_token:${accountId}`,
      ),
    ).toBe('RT-1')
  })

  it('o mesmo valor cifrado duas vezes produz registros diferentes', async () => {
    // Se dois tokens iguais gerassem o mesmo ciphertext, um observador do
    // banco saberia que duas contas compartilham credencial.
    const a = await seedAccount(3600_000)
    const b = await seedAccount(3600_000)

    const leitura = await adminClient()
      .from('reddit_account_secrets')
      .select('reddit_account_id, refresh_token_enc')
      .in('reddit_account_id', [a, b])

    const [um, dois] = leitura.data!
    expect(um.refresh_token_enc).not.toBe(dois.refresh_token_enc)
  })

  it('refresh inválido marca a conta como disconnected', async () => {
    accountId = await seedAccount(1000)
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(400, { error: 'invalid_grant' })

    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    await expect(
      getRedditClient({ id: accountId, owner_id: userA.id } as never, {
        dispatcher: agent,
        skipOwnershipCheck: true,
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_INVALID' })

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('status, last_error')
      .eq('id', accountId)
      .single()
    expect(data!.status).toBe('disconnected')
    expect(data!.last_error).not.toContain('RT-1')
  })

  it('o lock impede dois refreshes simultâneos da mesma conta', async () => {
    accountId = await seedAccount(60_000)
    agent
      .get('https://www.reddit.com')
      .intercept({ path: '/api/v1/access_token', method: 'POST' })
      .reply(200, {
        access_token: 'AT-UNICO',
        expires_in: 3600,
        scope: 'identity',
        token_type: 'bearer',
      })
      .times(1)

    const { getRedditClient } = await import('@/lib/reddit/reddit-client-factory')
    const chamada = () =>
      getRedditClient({ id: accountId, owner_id: userA.id } as never, {
        dispatcher: agent,
        skipOwnershipCheck: true,
      })

    // Se ambos renovassem, o segundo não encontraria intercept e falharia.
    const resultados = await Promise.allSettled([chamada(), chamada()])
    expect(resultados.filter((r) => r.status === 'fulfilled').length).toBe(2)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/reddit/factory.test.ts tests/db/factory-refresh.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
// src/lib/reddit/reddit-client-factory.ts
import 'server-only'
import { ProxyAgent, type Dispatcher } from 'undici'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/crypto/aes-gcm'
import {
  assertAccountAccess,
  getAccountSecrets,
  getNetworkConfig,
  type NetworkConfig,
  type VerifiedAccount,
} from '@/lib/auth/ownership'
import { refreshAccessToken } from './auth'
import { createRedditClient, type RedditClient } from './client'
import { RedditError } from './errors'
import type { RedditTokenResponse } from './types'

const REFRESH_MARGIN_MS = 120_000
const REFRESH_LOCK_MS = 30_000

/**
 * Monta a URL do proxy. Nunca logue o resultado: use a forma mascarada.
 * O sanitizador de logs redige este formato, mas não confie nisso como
 * primeira linha de defesa.
 */
export function buildProxyUrl(config: NetworkConfig): string {
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(
        config.password ?? '',
      )}@`
    : ''
  return `${config.protocol}://${auth}${config.host}:${config.port}`
}

/**
 * Dispatcher da conta. Sem configuração de rede, devolve undefined e o
 * undici usa o dispatcher global.
 *
 * A configuração é fixa por conta: não há pool, rotação, nem troca de rota
 * após erro.
 */
export function createDispatcherFor(
  config: NetworkConfig | null,
): Dispatcher | undefined {
  if (!config) return undefined
  return new ProxyAgent({ uri: buildProxyUrl(config) })
}

export async function persistTokens(
  accountId: string,
  token: RedditTokenResponse,
): Promise<void> {
  const admin = createAdminSupabase()
  const patch: Record<string, unknown> = {
    access_token_enc: encryptSecret(
      token.access_token,
      `reddit_account_secrets:access_token:${accountId}`,
    ),
    access_token_expires_at: new Date(
      Date.now() + token.expires_in * 1000,
    ).toISOString(),
    refresh_lock_at: null,
  }

  // O Reddit só devolve refresh_token na troca inicial; num refresh comum a
  // ausência é normal e o token antigo continua valendo.
  if (token.refresh_token) {
    patch.refresh_token_enc = encryptSecret(
      token.refresh_token,
      `reddit_account_secrets:refresh_token:${accountId}`,
    )
  }

  await admin
    .from('reddit_account_secrets')
    .update(patch)
    .eq('reddit_account_id', accountId)
}

async function markDisconnected(accountId: string, code: string) {
  const admin = createAdminSupabase()
  await admin
    .from('reddit_accounts')
    .update({
      status: 'disconnected',
      // Apenas o código do erro: nada de corpo de resposta ou token.
      last_error: code,
    })
    .eq('id', accountId)
}

/** Tenta tomar o lock de refresh. Falso significa "outro processo já está renovando". */
async function acquireRefreshLock(accountId: string): Promise<boolean> {
  const admin = createAdminSupabase()
  const cutoff = new Date(Date.now() - REFRESH_LOCK_MS).toISOString()
  const { data } = await admin
    .from('reddit_account_secrets')
    .update({ refresh_lock_at: new Date().toISOString() })
    .eq('reddit_account_id', accountId)
    .or(`refresh_lock_at.is.null,refresh_lock_at.lt.${cutoff}`)
    .select('reddit_account_id')
  return (data?.length ?? 0) === 1
}

export async function getRedditClient(
  account: VerifiedAccount,
  opts: {
    dispatcher?: Dispatcher
    /** Somente para testes que já montaram o cenário no banco. */
    skipOwnershipCheck?: boolean
  } = {},
): Promise<RedditClient> {
  const verified = opts.skipOwnershipCheck
    ? account
    : await assertAccountAccess(account.id)

  let secrets = await getAccountSecrets(verified)

  const precisaRenovar =
    secrets.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS

  if (precisaRenovar) {
    const gotLock = await acquireRefreshLock(verified.id)
    if (gotLock) {
      try {
        const token = await refreshAccessToken(
          secrets.refreshToken,
          opts.dispatcher,
        )
        await persistTokens(verified.id, token)
        secrets = await getAccountSecrets(verified)
      } catch (e) {
        if (e instanceof RedditError && e.code === 'REFRESH_INVALID') {
          await markDisconnected(verified.id, e.code)
        }
        throw e
      }
    } else {
      // Outro processo está renovando: relê o segredo já atualizado.
      secrets = await getAccountSecrets(verified)
    }
  }

  const dispatcher =
    opts.dispatcher ?? createDispatcherFor(await getNetworkConfig(verified))

  return createRedditClient({ accessToken: secrets.accessToken, dispatcher })
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/reddit/factory.test.ts tests/db/factory-refresh.test.ts`
Expected: PASS

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: factory de cliente reddit com refresh e dispatcher por conta"
```

---

### Task 8: Verificação empírica de `http`, `https` e `socks5`

**Files:**
- Create: `tests/reddit/proxy-support.test.ts`
- Create: `tests/helpers/local-proxies.ts`
- Create: `src/lib/reddit/proxy-support.ts`
- Modify: `README.md`

**Interfaces:**
- Produces:
  - `startHttpProxy(): Promise<{ port, requests, close }>`
  - `startSocks5Proxy(): Promise<{ port, connections, close }>`
  - `SUPPORTED_PROXY_PROTOCOLS: readonly ('http'|'https'|'socks5')[]`

A spec exige **não assumir** o suporte a proxy: a documentação atual do `ProxyAgent` indica que `socks5:` é delegado a um `Socks5ProxyAgent` interno, mas isso precisa ser confirmado contra a versão instalada. Se algum protocolo não funcionar, ele sai da lista e a UI deixa de oferecê-lo — em vez de prometer suporte inexistente.

- [ ] **Step 1: Escrever os proxies locais de teste**

```ts
// tests/helpers/local-proxies.ts
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'

/** Proxy HTTP mínimo: encaminha requisições de URI absoluto. */
export async function startHttpProxy() {
  const requests: string[] = []

  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    const alvo = new URL(req.url ?? '')
    const upstream = connect(Number(alvo.port || 80), alvo.hostname, () => {
      upstream.write(
        `${req.method} ${alvo.pathname}${alvo.search} HTTP/1.1\r\n` +
          `host: ${alvo.host}\r\n` +
          `connection: close\r\n\r\n`,
      )
      req.pipe(upstream)
    })
    upstream.on('data', (chunk) => res.socket?.write(chunk))
    upstream.on('end', () => res.socket?.end())
    upstream.on('error', () => res.socket?.destroy())
  })

  server.listen(0)
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port

  return {
    port,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/**
 * Proxy SOCKS5 mínimo (RFC 1928), apenas o necessário para CONNECT sem
 * autenticação: greeting, request e repasse do fluxo TCP.
 */
export async function startSocks5Proxy() {
  const connections: string[] = []

  const server = createTcpServer((client: Socket) => {
    let etapa: 'greeting' | 'request' | 'pipe' = 'greeting'

    client.on('data', (chunk) => {
      if (etapa === 'greeting') {
        // 0x05 <nmethods> <methods...>  ->  0x05 0x00 (sem autenticação)
        client.write(Buffer.from([0x05, 0x00]))
        etapa = 'request'
        return
      }

      if (etapa === 'request') {
        // 0x05 0x01 0x00 <atyp> <addr> <port>
        const atyp = chunk[3]
        let host: string
        let offset: number

        if (atyp === 0x01) {
          host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const len = chunk[4]
          host = chunk.subarray(5, 5 + len).toString('utf8')
          offset = 5 + len
        } else {
          client.destroy()
          return
        }

        const port = chunk.readUInt16BE(offset)
        connections.push(`${host}:${port}`)

        const upstream = connect(port, host, () => {
          // 0x05 0x00 0x00 0x01 0.0.0.0 0
          client.write(
            Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
          )
          etapa = 'pipe'
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.destroy())
      }
    })

    client.on('error', () => client.destroy())
  })

  server.listen(0)
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port

  return {
    port,
    connections,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
```

- [ ] **Step 2: Escrever o teste de suporte**

```ts
// tests/reddit/proxy-support.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fetch } from 'undici'
import { createDispatcherFor } from '@/lib/reddit/reddit-client-factory'
import { startHttpProxy, startSocks5Proxy } from '../helpers/local-proxies'

let alvo: { port: number; close: () => Promise<void> }

beforeAll(async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  server.listen(0)
  await once(server, 'listening')
  alvo = {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
})

afterAll(async () => {
  await alvo.close()
})

describe('suporte real a proxy na versão instalada do undici', () => {
  it('registra as versões de undici em uso', () => {
    // Diagnóstico: o fetch global do Node usa a linha bundled, que é uma
    // instância distinta da dependência instalada. Dispatcher de uma não
    // funciona no fetch da outra.
    expect(typeof process.versions.undici).toBe('string')
  })

  it('roteia por proxy HTTP', async () => {
    const proxy = await startHttpProxy()
    try {
      const dispatcher = createDispatcherFor({
        enabled: true,
        protocol: 'http',
        host: '127.0.0.1',
        port: proxy.port,
        username: null,
        password: null,
      })

      const res = await fetch(`http://127.0.0.1:${alvo.port}/teste`, {
        dispatcher,
      })
      expect(res.status).toBe(200)
      expect(proxy.requests.join(' ')).toContain(`127.0.0.1:${alvo.port}`)
    } finally {
      await proxy.close()
    }
  })

  it('roteia por proxy SOCKS5', async () => {
    const proxy = await startSocks5Proxy()
    try {
      const dispatcher = createDispatcherFor({
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port: proxy.port,
        username: null,
        password: null,
      })

      const res = await fetch(`http://127.0.0.1:${alvo.port}/teste`, {
        dispatcher,
      })
      expect(res.status).toBe(200)
      expect(proxy.connections).toContain(`127.0.0.1:${alvo.port}`)
    } finally {
      await proxy.close()
    }
  })

  it('proxy indisponível vira erro, sem tentar rota alternativa', async () => {
    const dispatcher = createDispatcherFor({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 1, // porta certamente fechada
      username: null,
      password: null,
    })

    await expect(
      fetch(`http://127.0.0.1:${alvo.port}/teste`, { dispatcher }),
    ).rejects.toBeTruthy()
  })
})
```

- [ ] **Step 3: Rodar os testes**

Run: `npx vitest run tests/reddit/proxy-support.test.ts`

**Este é o step decisivo do plano.** Registre o resultado real:

- Todos passam → mantenha os três protocolos.
- SOCKS5 falha → **não force**. Remova `socks5` de `SUPPORTED_PROXY_PROTOCOLS`, marque o teste com `it.skip` e um comentário citando a versão do undici, documente a limitação no README e deixe a UI oferecer apenas `http`/`https`. A alternativa (trazer `socks-proxy-agent` e um dispatcher customizado) fica registrada como opção futura, **não** implementada aqui.

- [ ] **Step 4: Registrar os protocolos efetivamente suportados**

```ts
// src/lib/reddit/proxy-support.ts
/**
 * Protocolos confirmados por teste de integração real contra a versão
 * instalada do undici (tests/reddit/proxy-support.test.ts).
 *
 * Ajuste esta lista APENAS com o teste correspondente passando. A UI e a
 * validação Zod derivam daqui, então remover um protocolo daqui o remove de
 * todo o produto.
 */
export const SUPPORTED_PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const

export type ProxyProtocol = (typeof SUPPORTED_PROXY_PROTOCOLS)[number]
```

- [ ] **Step 5: Documentar no README**

Acrescente à seção "Decisões de segurança já implementadas":

```markdown
- A configuração de rede por conta é **fixa**: uma conta usa sempre a mesma
  rota enquanto estiver habilitada. Não há pool, rotação, troca de IP após
  erro nem retry de 403 por outra rota. Proxy indisponível gera erro
  registrado e a política normal de retry para indisponibilidade transitória.
- Os protocolos de proxy oferecidos são os confirmados por teste de
  integração real contra a versão instalada do `undici`, não os presumidos
  pela documentação.
```

- [ ] **Step 6: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "test: verificacao empirica de proxy http, https e socks5"
```

---

### Task 9: Route handlers de autorização e callback

**Files:**
- Create: `src/app/api/reddit/authorize/route.ts`
- Create: `src/app/api/reddit/callback/route.ts`
- Create: `src/lib/reddit/connect-account.ts`
- Test: `tests/db/connect-account.test.ts`

**Atenção ao diretório do teste:** todo teste que toca o banco vive em
`tests/db/`, porque o CI roda `npm test -- --exclude "tests/db/**"` (o stack
local do Supabase não existe lá). Um teste de banco fora dessa pasta quebra o CI.

**Interfaces:**
- Consumes: `createOAuthState`, `consumeOAuthState`, `buildAuthorizeUrl`, `exchangeCode`, `fetchIdentity`, `persistTokens`
- Produces: `connectAccount(ownerId, token, identity): Promise<string>` — devolve o `reddit_account_id`

- [ ] **Step 1: Escrever o teste falhando**

```ts
// tests/db/connect-account.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { connectAccount } from '@/lib/reddit/connect-account'

let userA: { id: string; accessToken: string }

beforeAll(async () => {
  userA = await createTestUser(`ca-${Date.now()}@teste.local`)
})

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

const token = {
  access_token: 'AT-1',
  refresh_token: 'RT-1',
  expires_in: 3600,
  scope: 'identity submit mysubreddits',
  token_type: 'bearer',
}

describe('connectAccount', () => {
  it('cria a conta e guarda os segredos cifrados', async () => {
    const id = await connectAccount(userA.id, token, {
      id: 't2_abc',
      name: 'conta01',
    })

    const conta = await adminClient()
      .from('reddit_accounts')
      .select('username, status, scopes')
      .eq('id', id)
      .single()
    expect(conta.data!.username).toBe('conta01')
    expect(conta.data!.status).toBe('connected')
    expect(conta.data!.scopes).toContain('submit')

    const segredo = await adminClient()
      .from('reddit_account_secrets')
      .select('access_token_enc, refresh_token_enc')
      .eq('reddit_account_id', id)
      .single()

    const { decryptSecret } = await import('@/lib/crypto/aes-gcm')

    // Difere do claro, não contém o claro, e volta ao claro no servidor.
    expect(segredo.data!.access_token_enc).not.toBe('AT-1')
    expect(segredo.data!.access_token_enc).not.toContain('AT-1')
    expect(segredo.data!.refresh_token_enc).not.toContain('RT-1')
    expect(
      decryptSecret(
        segredo.data!.access_token_enc,
        `reddit_account_secrets:access_token:${id}`,
      ),
    ).toBe('AT-1')
    expect(
      decryptSecret(
        segredo.data!.refresh_token_enc,
        `reddit_account_secrets:refresh_token:${id}`,
      ),
    ).toBe('RT-1')
  })

  it('reconectar a mesma conta atualiza em vez de duplicar', async () => {
    const primeiro = await connectAccount(userA.id, token, {
      id: 't2_repetida',
      name: 'conta02',
    })
    const segundo = await connectAccount(
      userA.id,
      { ...token, access_token: 'AT-2' },
      { id: 't2_repetida', name: 'conta02_renomeada' },
    )
    expect(segundo).toBe(primeiro)

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('id, username')
      .eq('owner_id', userA.id)
      .eq('reddit_user_id', 't2_repetida')
    expect(data).toHaveLength(1)
    expect(data![0].username).toBe('conta02_renomeada')
  })

  it('reconectar limpa o status e o erro anterior', async () => {
    const id = await connectAccount(userA.id, token, {
      id: 't2_erro',
      name: 'conta03',
    })
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected', last_error: 'REFRESH_INVALID' })
      .eq('id', id)

    await connectAccount(userA.id, token, { id: 't2_erro', name: 'conta03' })

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('status, last_error')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('connected')
    expect(data!.last_error).toBeNull()
  })

  it('os escopos vêm da resposta do Reddit, não de uma lista fixa', async () => {
    const id = await connectAccount(
      userA.id,
      { ...token, scope: 'identity read' },
      { id: 't2_escopos', name: 'conta04' },
    )
    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('scopes')
      .eq('id', id)
      .single()
    expect(data!.scopes).toEqual(['identity', 'read'])
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/db/connect-account.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `connectAccount`**

```ts
// src/lib/reddit/connect-account.ts
import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/crypto/aes-gcm'
import type { RedditIdentity, RedditTokenResponse } from './types'

/**
 * Cria ou reconecta uma conta Reddit. Idempotente por (owner, reddit_user_id):
 * reconectar a mesma conta atualiza a linha existente em vez de duplicar.
 */
export async function connectAccount(
  ownerId: string,
  token: RedditTokenResponse,
  identity: RedditIdentity,
): Promise<string> {
  const admin = createAdminSupabase()

  const { data: conta, error } = await admin
    .from('reddit_accounts')
    .upsert(
      {
        owner_id: ownerId,
        reddit_user_id: identity.id,
        username: identity.name,
        scopes: token.scope.split(' ').filter(Boolean),
        status: 'connected',
        last_error: null,
        last_authenticated_at: new Date().toISOString(),
      },
      { onConflict: 'owner_id,reddit_user_id' },
    )
    .select('id')
    .single()

  if (error || !conta) throw error ?? new Error('Falha ao gravar a conta.')

  const accountId = conta.id as string

  await admin.from('reddit_account_secrets').upsert(
    {
      reddit_account_id: accountId,
      owner_id: ownerId,
      access_token_enc: encryptSecret(
        token.access_token,
        `reddit_account_secrets:access_token:${accountId}`,
      ),
      refresh_token_enc: encryptSecret(
        token.refresh_token!,
        `reddit_account_secrets:refresh_token:${accountId}`,
      ),
      access_token_expires_at: new Date(
        Date.now() + token.expires_in * 1000,
      ).toISOString(),
      refresh_lock_at: null,
    },
    { onConflict: 'reddit_account_id' },
  )

  return accountId
}
```

- [ ] **Step 4: Implementar os route handlers**

```ts
// src/app/api/reddit/authorize/route.ts
import { NextResponse } from 'next/server'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'
import { buildAuthorizeUrl, createOAuthState } from '@/lib/reddit/auth'
import { getCoreEnv } from '@/lib/config/env'

// ProxyAgent e node:crypto exigem o runtime Node.
export const runtime = 'nodejs'

export async function GET() {
  const base = getCoreEnv().APP_URL

  let user
  try {
    user = await requireUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL('/login', base))
    }
    throw e
  }

  const { value, cookie } = await createOAuthState(user.id)
  const response = NextResponse.redirect(buildAuthorizeUrl(value))
  response.cookies.set(cookie.name, cookie.value, {
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    path: cookie.path,
    maxAge: cookie.maxAge,
  })
  return response
}
```

```ts
// src/app/api/reddit/callback/route.ts
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'
import {
  consumeOAuthState,
  exchangeCode,
  fetchIdentity,
  STATE_COOKIE,
} from '@/lib/reddit/auth'
import { connectAccount } from '@/lib/reddit/connect-account'
import { getCoreEnv } from '@/lib/config/env'
import { sanitize } from '@/lib/logging/sanitize'

export const runtime = 'nodejs'

function back(base: string, erro?: string) {
  const url = new URL('/dashboard/accounts', base)
  if (erro) url.searchParams.set('erro', erro)
  const response = NextResponse.redirect(url)
  // O cookie de state é descartado em qualquer desfecho.
  response.cookies.delete(STATE_COOKIE)
  return response
}

export async function GET(request: NextRequest) {
  const base = getCoreEnv().APP_URL

  let user
  try {
    user = await requireUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL('/login', base))
    }
    throw e
  }

  const params = request.nextUrl.searchParams

  // O usuário pode simplesmente ter recusado no Reddit.
  if (params.get('error')) {
    return back(base, 'autorizacao_recusada')
  }

  const code = params.get('code')
  const state = params.get('state')
  const cookie = request.cookies.get(STATE_COOKIE)?.value

  if (!code || !state || !cookie || cookie !== state) {
    return back(base, 'state_invalido')
  }

  try {
    // Consome antes de qualquer chamada externa: uso único, vinculado à sessão.
    await consumeOAuthState(state, user.id)
    const token = await exchangeCode(code)
    const identity = await fetchIdentity(token.access_token)
    await connectAccount(user.id, token, identity)
    return back(base)
  } catch (e) {
    console.error('reddit/callback', sanitize(e))
    return back(base, 'falha_ao_conectar')
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/db/connect-account.test.ts`
Expected: PASS (4 testes)

- [ ] **Step 6: Verificação manual com credenciais reais**

Requer `.env.local` completo (Fase -1).

```powershell
npm run dev
```

1. Entre no painel e acesse `/api/reddit/authorize` — deve redirecionar ao Reddit pedindo os escopos.
2. Autorize. O retorno deve cair em `/dashboard/accounts` sem erro na query string.
3. Confirme no banco que a conta e os segredos existem, e que **nada** está em claro:

```powershell
npx supabase db query "select username, status, scopes from public.reddit_accounts"
npx supabase db query "select left(access_token_enc, 3) as prefixo from public.reddit_account_secrets"
```

Esperado: a conta com `status = connected`, e o prefixo `v1.` — nunca o token legível.

4. Recarregue o callback antigo no navegador (F5 na URL de retorno). Deve falhar com `state_invalido`: o state é de uso único.

- [ ] **Step 7: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: rotas de autorizacao e callback do oauth reddit"
```

---

### Task 10: Página Contas Reddit e configuração de rede

**Files:**
- Create: `src/app/(dashboard)/accounts/page.tsx`
- Create: `src/app/(dashboard)/accounts/actions.ts`
- Create: `src/app/(dashboard)/accounts/schema.ts`
- Create: `src/components/accounts/account-card.tsx`
- Create: `src/components/accounts/network-form.tsx`
- Create: `src/lib/reddit/network-config.ts`
- Test: `tests/accounts/schema.test.ts`
- Test: `tests/accounts/actions-security.test.ts`
- Test: `tests/db/network-config.test.ts`

**Interfaces:**
- Consumes: `assertAccountAccess`, `SUPPORTED_PROXY_PROTOCOLS`, view `reddit_account_network_status`
- Produces:
  - `networkConfigSchema` (Zod)
  - server actions `saveNetworkConfig(prev, formData)`, `disableNetworkConfig(prev, formData)`, `disconnectAccount(prev, formData)`

**Rota:** a página vive em `/dashboard/accounts`, coerente com `NAV_ITEMS` do Plano 1.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/accounts/schema.test.ts
import { describe, expect, it } from 'vitest'
import { networkConfigSchema } from '@/app/(dashboard)/accounts/schema'
import { SUPPORTED_PROXY_PROTOCOLS } from '@/lib/reddit/proxy-support'

const valido = {
  accountId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  protocol: 'socks5',
  host: 'proxy.exemplo.com',
  port: '1080',
  username: 'usuario',
  password: 'senha-secreta',
}

describe('networkConfigSchema', () => {
  it('aceita uma configuração completa', () => {
    expect(networkConfigSchema.safeParse(valido).success).toBe(true)
  })

  it('aceita configuração sem credenciais', () => {
    const r = networkConfigSchema.safeParse({
      ...valido,
      username: '',
      password: '',
    })
    expect(r.success).toBe(true)
  })

  it('rejeita protocolo não suportado pela versão instalada do undici', () => {
    const r = networkConfigSchema.safeParse({ ...valido, protocol: 'ftp' })
    expect(r.success).toBe(false)
  })

  it('só aceita os protocolos confirmados por teste', () => {
    for (const p of SUPPORTED_PROXY_PROTOCOLS) {
      expect(networkConfigSchema.safeParse({ ...valido, protocol: p }).success).toBe(
        true,
      )
    }
  })

  it('rejeita porta fora da faixa', () => {
    expect(networkConfigSchema.safeParse({ ...valido, port: '0' }).success).toBe(false)
    expect(networkConfigSchema.safeParse({ ...valido, port: '70000' }).success).toBe(
      false,
    )
  })

  it('rejeita accountId que não é UUID', () => {
    expect(
      networkConfigSchema.safeParse({ ...valido, accountId: 'nao-e-uuid' }).success,
    ).toBe(false)
  })

  it('rejeita host vazio', () => {
    expect(networkConfigSchema.safeParse({ ...valido, host: '  ' }).success).toBe(
      false,
    )
  })

  it('converte a porta para número', () => {
    const r = networkConfigSchema.parse(valido)
    expect(r.port).toBe(1080)
  })
})

```

E o teste da regra da senha, que precisa do banco:

```ts
// tests/db/network-config.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import {
  saveNetworkConfigFor,
  clearNetworkConfigFor,
  clearProxyCredentialsFor,
} from '@/lib/reddit/network-config'
import type { VerifiedAccount } from '@/lib/auth/ownership'

let userA: { id: string; accessToken: string }
let account: VerifiedAccount

const base = {
  protocol: 'socks5' as const,
  host: 'proxy.exemplo.com',
  port: 1080,
  username: 'usuario',
}

async function lerConfig() {
  const { data } = await adminClient()
    .from('reddit_account_network_configs')
    .select('proxy_password_enc, proxy_host, proxy_port')
    .eq('reddit_account_id', account.id)
    .single()
  return data!
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  userA = await createTestUser(`nc-${Date.now()}@teste.local`)

  const { data } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_nc_${Date.now()}`,
      username: 'conta_rede',
    })
    .select('id, owner_id')
    .single()

  account = data as unknown as VerifiedAccount
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('saveNetworkConfigFor', () => {
  it('grava a senha cifrada, nunca em claro', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    const config = await lerConfig()
    expect(config.proxy_password_enc).not.toContain('senha-secreta')
    expect(config.proxy_password_enc!.startsWith('v1.')).toBe(true)
  })

  it('senha em branco mantém a senha já gravada', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    const antes = await lerConfig()

    await saveNetworkConfigFor(account, {
      ...base,
      port: 3128,
      password: '',
    })
    const depois = await lerConfig()

    expect(depois.proxy_password_enc).toBe(antes.proxy_password_enc)
    expect(depois.proxy_port).toBe(3128)
  })

  it('senha nova substitui a anterior', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-um' })
    const antes = await lerConfig()

    await saveNetworkConfigFor(account, { ...base, password: 'senha-dois' })
    const depois = await lerConfig()

    expect(depois.proxy_password_enc).not.toBe(antes.proxy_password_enc)
  })
})

describe('clearProxyCredentialsFor', () => {
  it('apaga usuário e senha mantendo host, porta e protocolo', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    await clearProxyCredentialsFor(account)

    const { data } = await adminClient()
      .from('reddit_account_network_configs')
      .select(
        'proxy_username, proxy_password_enc, proxy_host, proxy_port, proxy_protocol, proxy_enabled',
      )
      .eq('reddit_account_id', account.id)
      .single()

    expect(data!.proxy_username).toBeNull()
    expect(data!.proxy_password_enc).toBeNull()
    expect(data!.proxy_host).toBe('proxy.exemplo.com')
    expect(data!.proxy_port).toBe(1080)
    expect(data!.proxy_protocol).toBe('socks5')
    expect(data!.proxy_enabled).toBe(true)
  })

  it('depois de limpar, salvar sem senha não ressuscita a antiga', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    await clearProxyCredentialsFor(account)
    await saveNetworkConfigFor(account, { ...base, username: '', password: '' })

    const config = await lerConfig()
    expect(config.proxy_password_enc).toBeNull()
  })

  it('o dispatcher passa a ser montado sem credenciais', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    await clearProxyCredentialsFor(account)

    const { getNetworkConfig } = await import('@/lib/auth/ownership')
    const { buildProxyUrl } = await import('@/lib/reddit/reddit-client-factory')
    const config = await getNetworkConfig(account)

    expect(config).not.toBeNull()
    expect(config!.username).toBeNull()
    expect(config!.password).toBeNull()
    expect(buildProxyUrl(config!)).toBe('socks5://proxy.exemplo.com:1080')
  })

  it('salvar atualiza os campos derivados com o host mascarado', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'x' })
    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('proxy_enabled, proxy_host_masked, proxy_protocol, proxy_port')
      .eq('id', account.id)
      .single()

    expect(data!.proxy_enabled).toBe(true)
    expect(data!.proxy_host_masked).toBe('pr***.exemplo.com')
    expect(data!.proxy_protocol).toBe('socks5')
  })

  it('limpar a configuração zera os campos derivados', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'x' })
    await clearNetworkConfigFor(account)

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('proxy_enabled, proxy_host_masked, proxy_port')
      .eq('id', account.id)
      .single()

    expect(data!.proxy_enabled).toBe(false)
    expect(data!.proxy_host_masked).toBeNull()
    expect(data!.proxy_port).toBeNull()
  })
})
```

```ts
// tests/accounts/actions-security.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/app/(dashboard)/accounts/actions.ts', 'utf8')

describe('server actions de contas', () => {
  it('toda action passa por assertAccountAccess antes de tocar em segredo', () => {
    const actions = source
      .split('export async function')
      .slice(1)
      .filter((bloco) => bloco.includes('accountId'))
    expect(actions.length).toBeGreaterThan(0)
    for (const bloco of actions) {
      expect(bloco).toContain('assertAccountAccess')
    }
  })

  it('nenhuma action usa o client administrativo diretamente com id do formulário', () => {
    // O acesso a segredos passa sempre pelos helpers tipados.
    const trechos = source.split('\n')
    const usaAdmin = trechos.some(
      (l) => l.includes('createAdminSupabase') && !l.trim().startsWith('//'),
    )
    expect(usaAdmin).toBe(false)
  })

  it('valida a entrada com Zod', () => {
    expect(source).toContain('networkConfigSchema')
    expect(source).toContain('safeParse')
  })

  it('nunca devolve senha ao cliente', () => {
    expect(source).not.toMatch(/return\s*\{[^}]*password/)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/accounts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar o schema**

```ts
// src/app/(dashboard)/accounts/schema.ts
import { z } from 'zod'
import { SUPPORTED_PROXY_PROTOCOLS } from '@/lib/reddit/proxy-support'

export const networkConfigSchema = z.object({
  accountId: z.uuid(),
  protocol: z.enum(SUPPORTED_PROXY_PROTOCOLS),
  host: z.string().trim().min(1, 'Informe o host.'),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().default(''),
  password: z.string().default(''),
})

export type NetworkConfigForm = z.infer<typeof networkConfigSchema>

export type ActionState = { error: string | null; ok: boolean }
```

- [ ] **Step 4: Implementar as server actions**

```ts
// src/app/(dashboard)/accounts/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { assertAccountAccess, ForbiddenError } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import {
  saveNetworkConfigFor,
  clearNetworkConfigFor,
  clearProxyCredentialsFor,
} from '@/lib/reddit/network-config'
import { networkConfigSchema, type ActionState } from './schema'

export async function saveNetworkConfig(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = networkConfigSchema.safeParse({
    accountId: formData.get('accountId'),
    protocol: formData.get('protocol'),
    host: formData.get('host'),
    port: formData.get('port'),
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, ok: false }
  }

  try {
    // Posse verificada antes de qualquer escrita em tabela de segredo.
    const account = await assertAccountAccess(parsed.data.accountId)
    await saveNetworkConfigFor(account, parsed.data)
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return { error: 'Conta não encontrada.', ok: false }
    }
    return { error: 'Não foi possível salvar a configuração de rede.', ok: false }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}

export async function disableNetworkConfig(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const accountId = String(formData.get('accountId') ?? '')

  try {
    const account = await assertAccountAccess(accountId)
    await clearNetworkConfigFor(account)
  } catch {
    return { error: 'Não foi possível desativar a configuração de rede.', ok: false }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}

export async function clearProxyCredentials(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const accountId = String(formData.get('accountId') ?? '')

  try {
    const account = await assertAccountAccess(accountId)
    await clearProxyCredentialsFor(account)
  } catch {
    return {
      error: 'Não foi possível remover as credenciais do proxy.',
      ok: false,
    }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}

export async function disconnectAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const accountId = String(formData.get('accountId') ?? '')

  try {
    const account = await assertAccountAccess(accountId)
    // A remoção usa o client do usuário: a RLS é a última barreira.
    const supabase = await createServerSupabase()
    const { error } = await supabase
      .from('reddit_accounts')
      .delete()
      .eq('id', account.id)
    if (error) throw error
  } catch {
    return { error: 'Não foi possível desconectar a conta.', ok: false }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}
```

```ts
// src/lib/reddit/network-config.ts
import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/crypto/aes-gcm'
import type { VerifiedAccount } from '@/lib/auth/ownership'
import type { ProxyProtocol } from './proxy-support'

// O tipo vive aqui, não em app/: lib/ nunca importa de app/, ou a camada de
// domínio passa a depender da camada de apresentação.
export type NetworkConfigInput = {
  protocol: ProxyProtocol
  host: string
  port: number
  username: string
  password: string
}

export async function saveNetworkConfigFor(
  account: VerifiedAccount,
  input: NetworkConfigInput,
): Promise<void> {
  const admin = createAdminSupabase()

  // Senha em branco significa "mantenha a atual", porque o formulário nunca
  // recebe a senha de volta do servidor e portanto não teria como reenviá-la.
  let passwordEnc: string | null = null
  if (input.password) {
    passwordEnc = encryptSecret(
      input.password,
      `reddit_account_network_configs:proxy_password:${account.id}`,
    )
  } else {
    const { data } = await admin
      .from('reddit_account_network_configs')
      .select('proxy_password_enc')
      .eq('reddit_account_id', account.id)
      .maybeSingle()
    passwordEnc = data?.proxy_password_enc ?? null
  }

  await admin.from('reddit_account_network_configs').upsert(
    {
      reddit_account_id: account.id,
      owner_id: account.owner_id,
      proxy_enabled: true,
      proxy_protocol: input.protocol,
      proxy_host: input.host,
      proxy_port: input.port,
      proxy_username: input.username || null,
      proxy_password_enc: passwordEnc,
    },
    { onConflict: 'reddit_account_id' },
  )
}

/**
 * Remove usuário e senha do proxy, mantendo host, porta e protocolo.
 *
 * Existe porque "senha em branco preserva a atual" torna impossível apagar
 * uma credencial pelo formulário: sem esta ação, uma senha gravada por engano
 * ficaria no banco para sempre.
 */
export async function clearProxyCredentialsFor(
  account: VerifiedAccount,
): Promise<void> {
  const admin = createAdminSupabase()
  await admin
    .from('reddit_account_network_configs')
    .update({ proxy_username: null, proxy_password_enc: null })
    .eq('reddit_account_id', account.id)
}

/** Remove a configuração de rede inteira: a conta volta à conexão direta. */
export async function clearNetworkConfigFor(
  account: VerifiedAccount,
): Promise<void> {
  const admin = createAdminSupabase()
  await admin
    .from('reddit_account_network_configs')
    .delete()
    .eq('reddit_account_id', account.id)
}
```

- [ ] **Step 5: Implementar a página**

```tsx
// src/app/(dashboard)/accounts/page.tsx
import Link from 'next/link'
import { createServerSupabase } from '@/lib/supabase/server'
import { AccountCard } from '@/components/accounts/account-card'

const MENSAGENS: Record<string, string> = {
  state_invalido:
    'A solicitação expirou ou já foi usada. Tente conectar a conta novamente.',
  autorizacao_recusada: 'A autorização foi recusada no Reddit.',
  falha_ao_conectar:
    'Não foi possível concluir a conexão com o Reddit. Tente novamente.',
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>
}) {
  const { erro } = await searchParams
  const supabase = await createServerSupabase()

  const { data: contas } = await supabase
    .from('reddit_accounts')
    .select('id, username, status, scopes, last_authenticated_at, last_error')
    .order('username')

  const { data: rede } = await supabase
    .from('reddit_account_network_status')
    .select('reddit_account_id, proxy_enabled, proxy_protocol, proxy_host_masked, proxy_port')

  const redePorConta = new Map((rede ?? []).map((r) => [r.reddit_account_id, r]))

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
            Contas Reddit
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Conecte suas contas via OAuth oficial do Reddit.
          </p>
        </div>
        <Link
          href="/api/reddit/authorize"
          prefetch={false}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Conectar conta
        </Link>
      </div>

      {erro && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {MENSAGENS[erro] ?? 'Não foi possível concluir a operação.'}
        </p>
      )}

      {(contas ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Nenhuma conta conectada ainda.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {contas!.map((conta) => (
            <li key={conta.id}>
              <AccountCard
                account={conta}
                network={redePorConta.get(conta.id) ?? null}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

```tsx
// src/components/accounts/account-card.tsx
import { NetworkForm } from './network-form'

const STATUS_LABEL: Record<string, string> = {
  connected: 'Conectada',
  expired: 'Autorização expirada',
  disconnected: 'Desconectada',
  revoked: 'Revogada',
}

const STATUS_CLASS: Record<string, string> = {
  connected: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  expired: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  disconnected: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  revoked: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
}

export type AccountRow = {
  id: string
  username: string
  status: string
  scopes: string[]
  last_authenticated_at: string | null
  last_error: string | null
}

export type NetworkRow = {
  proxy_enabled: boolean
  proxy_protocol: string | null
  proxy_host_masked: string | null
  proxy_port: number | null
}

export function AccountCard({
  account,
  network,
}: {
  account: AccountRow
  network: NetworkRow | null
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium text-neutral-900 dark:text-neutral-50">
            u/{account.username}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {account.last_authenticated_at
              ? `Autorizada em ${new Date(
                  account.last_authenticated_at,
                ).toLocaleString('pt-BR')}`
              : 'Nunca autorizada'}
          </p>
        </div>

        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            STATUS_CLASS[account.status] ?? STATUS_CLASS.disconnected
          }`}
        >
          {STATUS_LABEL[account.status] ?? account.status}
        </span>
      </div>

      {account.status !== 'connected' && (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          Esta conta precisa ser reconectada para voltar a publicar.
        </p>
      )}

      <p className="mt-3 text-xs text-neutral-500">
        Permissões: {account.scopes.join(', ')}
      </p>

      <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <p className="text-xs text-neutral-500">
          {network?.proxy_enabled
            ? `Rede: ${network.proxy_protocol}://${network.proxy_host_masked}:${network.proxy_port}`
            : 'Rede: conexão direta'}
        </p>
        <NetworkForm
          accountId={account.id}
          enabled={network?.proxy_enabled ?? false}
        />
      </div>
    </div>
  )
}
```

```tsx
// src/components/accounts/network-form.tsx
'use client'

import { useActionState, useState } from 'react'
import {
  clearProxyCredentials,
  disableNetworkConfig,
  disconnectAccount,
  saveNetworkConfig,
} from '@/app/(dashboard)/accounts/actions'
import type { ActionState } from '@/app/(dashboard)/accounts/schema'
import { SUPPORTED_PROXY_PROTOCOLS } from '@/lib/reddit/proxy-support'

const initial: ActionState = { error: null, ok: false }

const field =
  'mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100'

export function NetworkForm({
  accountId,
  enabled,
}: {
  accountId: string
  enabled: boolean
}) {
  const [aberto, setAberto] = useState(false)
  const [state, action, pending] = useActionState(saveNetworkConfig, initial)
  const [, disableAction, disabling] = useActionState(
    disableNetworkConfig,
    initial,
  )
  const [, clearCredsAction, clearingCreds] = useActionState(
    clearProxyCredentials,
    initial,
  )
  const [, disconnectAction, disconnecting] = useActionState(
    disconnectAccount,
    initial,
  )

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
        >
          {aberto ? 'Fechar' : 'Configurar rede'}
        </button>

        {enabled && (
          <>
            <form action={clearCredsAction}>
              <input type="hidden" name="accountId" value={accountId} />
              <button
                disabled={clearingCreds}
                title="Remove usuário e senha, mantendo host e porta"
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
              >
                Remover credenciais
              </button>
            </form>

            <form action={disableAction}>
              <input type="hidden" name="accountId" value={accountId} />
              <button
                disabled={disabling}
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
              >
                Usar conexão direta
              </button>
            </form>
          </>
        )}

        <form action={disconnectAction}>
          <input type="hidden" name="accountId" value={accountId} />
          <button
            disabled={disconnecting}
            className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-400"
          >
            Desconectar conta
          </button>
        </form>
      </div>

      {aberto && (
        <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="accountId" value={accountId} />

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
            Protocolo
            <select name="protocol" className={field} defaultValue="http">
              {SUPPORTED_PROXY_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
            Host
            <input name="host" required className={field} />
          </label>

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
            Porta
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              required
              className={field}
            />
          </label>

          <label className="text-xs text-neutral-600 dark:text-neutral-400">
            Usuário (opcional)
            <input name="username" autoComplete="off" className={field} />
          </label>

          <label className="text-xs text-neutral-600 dark:text-neutral-400 sm:col-span-2">
            Senha (opcional)
            {/* Nasce sempre vazio: a senha nunca volta do servidor. */}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              className={field}
            />
            <span className="mt-1 block text-[11px] text-neutral-500">
              Deixe em branco para manter a senha atual.
            </span>
          </label>

          {state.error && (
            <p role="alert" className="text-xs text-red-600 sm:col-span-2">
              {state.error}
            </p>
          )}

          <div className="sm:col-span-2">
            <button
              disabled={pending}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {pending ? 'Salvando…' : 'Salvar configuração de rede'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
```

Nota sobre a senha em branco: o schema aceita `password: ''`, e
`saveNetworkConfigFor` grava `null` nesse caso. Para que "deixe em branco
mantém a senha atual" seja verdade, `saveNetworkConfigFor` só sobrescreve
`proxy_password_enc` quando `input.password` não é vazio — ajuste incluído no
Step 4.

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run tests/accounts tests/db/network-config.test.ts`
Expected: PASS

- [ ] **Step 7: Verificação manual**

```powershell
npm run dev
```

1. `/dashboard/accounts` lista a conta conectada na Task 9.
2. Configure um proxy fictício (`socks5`, `proxy.exemplo.com`, `1080`, com senha).
3. Recarregue: o host aparece **mascarado** (`pr***.exemplo.com`) e a senha **não** volta preenchida.
4. No DevTools, aba Network, confirme que nenhuma resposta contém a senha, o usuário do proxy ou o host completo.
5. Desconecte a conta e confirme em cascata:

```powershell
npx supabase db query "select count(*) from public.reddit_account_secrets"
```

- [ ] **Step 8: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: pagina de contas reddit com configuracao de rede por conta"
```

---

## Critério de aceitação do Plano 2

- [ ] `npm run verify` verde
- [ ] Conectar conta pelo OAuth oficial funciona ponta a ponta com credenciais reais
- [ ] Reusar o mesmo `state` falha (`state_invalido`), provado em teste e no navegador
- [ ] `state` de outra sessão é recusado, e a recusa **não** consome o state do dono legítimo
- [ ] Nenhum token ou senha de proxy é legível no banco, provado por três
      verificações e não pelo prefixo do envelope: o valor armazenado difere do
      texto claro, não o contém (nem em base64 ou hex), e o decrypt server-side
      devolve exatamente o original
- [ ] Cifrar o mesmo valor duas vezes produz registros diferentes
- [ ] Existe ação explícita para remover usuário e senha do proxy mantendo
      host e porta, com teste dedicado
- [ ] `VerifiedAccount` é tratado como ergonomia: a garantia é provada por
      checagem de posse em runtime, RLS, constraints e testes A/B
- [ ] O dono da conta **não** consegue ler `reddit_account_secrets` nem `reddit_account_network_configs` pelo Data API
- [ ] A view devolve host mascarado e nunca usuário, senha ou host completo
- [ ] Usuário A não lê, altera nem usa contas, segredos ou configuração de rede de B (suíte IDOR)
- [ ] Refresh renova antes de expirar, persiste cifrado e o lock impede renovação dupla
- [ ] Refresh inválido marca a conta como `disconnected` com mensagem humana
- [ ] `500`, `502`, `503` e `504` em requisição de efeito viram `unknown`; em leitura, `retryable`
- [ ] Protocolos de proxy oferecidos = protocolos confirmados por teste real contra o undici instalado
- [ ] Proxy indisponível gera erro registrado, sem troca de rota
- [ ] Nenhum teste faz requisição real ao Reddit; a suíte passa sem `REDDIT_CLIENT_ID`
- [ ] Todo teste que toca o banco está em `tests/db/`, e `npm test -- --exclude "tests/db/**"` passa
- [ ] Senha de proxy em branco mantém a anterior; senha nova a substitui
- [ ] `npx supabase db advisors --local` sem apontamentos

## O que vem no Plano 3

Fase 3 da spec: sincronização das comunidades moderadas
(`/subreddits/mine/moderator`), flairs (`link_flair_v2`) e requisitos de
publicação (`post_requirements`) — a base que o formulário de nova publicação
consome no Plano 4.
