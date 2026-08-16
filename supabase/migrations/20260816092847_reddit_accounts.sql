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
