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

-- ---------------------------------------------------------------
-- Somente leitura pelo Data API.
-- ---------------------------------------------------------------
-- Criar, reagendar e cancelar passam exclusivamente pelas funções em
-- migrations posteriores. Conceder INSERT ou UPDATE direto aqui permitiria ao
-- cliente contornar post_requirements, a confirmação de link+texto e a
-- validação de horário — todas as regras do domínio moram naquelas funções.
grant select on public.scheduled_posts to authenticated;
grant all on public.scheduled_posts to service_role;

create policy "scheduled_posts_select_own"
  on public.scheduled_posts for select
  to authenticated
  using ( (select auth.uid()) = owner_id );

-- As policies de escrita ficam, mesmo sem grant correspondente: são a segunda
-- barreira se um grant for concedido por engano numa migration futura.
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
