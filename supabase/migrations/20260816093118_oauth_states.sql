-- State do fluxo OAuth do Reddit.
--
-- O consumo é um único UPDATE condicional (consumed_at is null and
-- expires_at > now()), e é ele que torna o replay impossível: a segunda
-- tentativa não encontra linha para atualizar. Não há função SQL aqui — a
-- atomicidade vem da própria instrução.
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
