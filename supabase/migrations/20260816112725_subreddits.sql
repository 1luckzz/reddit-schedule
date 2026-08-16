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
