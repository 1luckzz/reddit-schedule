-- ---------------------------------------------------------------
-- Caminho de publicação via Devvit (migração progressiva)
-- ---------------------------------------------------------------
-- O site continua a interface única; o Devvit passa a ser um mecanismo de
-- execução alternativo ao worker. Nada do fluxo antigo é removido: um post
-- nasce com publisher = 'worker' (comportamento atual) ou 'devvit' (novo
-- caminho), e os claims do worker enxergam SOMENTE 'worker' — é isso que
-- impede o worker antigo de publicar um job destinado ao Devvit.

-- ---------------------------------------------------------------
-- 1. Instalações Devvit permitidas
-- ---------------------------------------------------------------
-- Uma linha por (usuário, subreddit) onde o app Devvit está instalado.
-- app_slug e install_location_id são os identificadores OFICIAIS da
-- instalação (é deles que a URL do External Endpoint deriva; nenhum hash
-- próprio é inventado nem persistido).
create table public.devvit_installations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,

  -- Nome do subreddit sem o prefixo r/, sempre minúsculo: nomes de subreddit
  -- são case-insensitive no Reddit e a comparação aqui precisa ser exata.
  subreddit_name text not null,
  -- Slug do app na plataforma Devvit. Ex.: 'grapepos2'.
  app_slug text not null,
  -- ID oficial da instalação (t5_…), exigido pela API de External Endpoints
  -- para montar a URL. Pode ser preenchido depois do registro inicial.
  install_location_id text,

  status text not null default 'active'
    check (status in ('active', 'disabled')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint subreddit_minusculo check (subreddit_name = lower(subreddit_name)),
  constraint subreddit_nao_vazio check (length(btrim(subreddit_name)) > 0),
  constraint app_slug_nao_vazio check (length(btrim(app_slug)) > 0),

  unique (owner_id, subreddit_name),
  -- Para a FK composta de scheduled_posts: integridade entre owners no banco.
  unique (id, owner_id)
);

alter table public.devvit_installations enable row level security;

-- Escrita exclusiva do backend: o usuário não cadastra instalação pelo Data
-- API — sem policies de INSERT/UPDATE, a RLS nega tudo que não for SELECT.
grant select on public.devvit_installations to authenticated;
grant all on public.devvit_installations to service_role;

create policy "devvit_installations_select_own"
  on public.devvit_installations for select
  to authenticated
  using ( (select auth.uid()) = owner_id );

create trigger devvit_installations_set_updated_at
  before update on public.devvit_installations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- 2. Colunas do caminho Devvit em scheduled_posts
-- ---------------------------------------------------------------
alter table public.scheduled_posts
  add column publisher text not null default 'worker'
    check (publisher in ('worker', 'devvit')),
  add column devvit_installation_id uuid,
  add column devvit_job_id text,
  add column devvit_sync_status text
    check (devvit_sync_status in ('pending', 'sent', 'accepted', 'failed')),
  add column devvit_sync_error text;

alter table public.scheduled_posts
  add constraint scheduled_posts_devvit_installation_fkey
    foreign key (devvit_installation_id, owner_id)
    references public.devvit_installations (id, owner_id) on delete cascade;

-- Um post 'devvit' sempre sabe por qual instalação sai e em que ponto da
-- sincronização está; um post 'worker' não carrega resíduo do outro caminho.
alter table public.scheduled_posts
  add constraint devvit_coerente check (
    (publisher = 'worker'
       and devvit_installation_id is null
       and devvit_job_id is null
       and devvit_sync_status is null
       and devvit_sync_error is null)
    or (publisher = 'devvit'
       and devvit_installation_id is not null
       and devvit_sync_status is not null)
  );

-- A reconciliação futura varre por aqui: o que ainda não foi confirmado.
create index scheduled_posts_devvit_sync_idx
  on public.scheduled_posts (devvit_sync_status)
  where publisher = 'devvit'
    and devvit_sync_status in ('pending', 'sent');

-- ---------------------------------------------------------------
-- 3. Claims do worker antigo ignoram o caminho Devvit
-- ---------------------------------------------------------------
-- Mesmo corpo da versão anterior (CTE materializada, lock só no candidato),
-- com UMA linha nova por função: o filtro de publisher. Sem ele o worker
-- reivindicaria o job e publicaria em duplicidade com o Devvit — pela
-- identidade errada.
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
  with due as materialized (
    select candidato.id
    from public.scheduled_posts candidato
    join public.reddit_accounts ra on ra.id = candidato.reddit_account_id
    where candidato.status = 'scheduled'
      -- O worker antigo só executa o próprio caminho.
      and candidato.publisher = 'worker'
      and candidato.scheduled_at <= now()
      and (candidato.next_attempt_at is null
           or candidato.next_attempt_at <= now())
      and ra.status = 'connected'
      and (ra.last_submit_at is null
           or ra.last_submit_at
              + make_interval(secs => ra.min_interval_seconds) <= now())
    order by candidato.scheduled_at
    for update of candidato skip locked
    limit p_batch
  )
  update public.scheduled_posts sp
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id
  from due
  where sp.id = due.id
  returning sp.*;
end;
$$;

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
  with due as materialized (
    select candidato.id
    from public.scheduled_comments candidato
    join public.scheduled_posts sp on sp.id = candidato.scheduled_post_id
    join public.reddit_accounts ra on ra.id = candidato.reddit_account_id
    where candidato.status = 'scheduled'
      and candidato.scheduled_at is not null
      and candidato.scheduled_at <= now()
      and (candidato.next_attempt_at is null
           or candidato.next_attempt_at <= now())
      and sp.status = 'published'
      and sp.reddit_fullname is not null
      -- Comentário de post Devvit é publicado pelo próprio app Devvit.
      and sp.publisher = 'worker'
      and ra.status = 'connected'
    order by candidato.scheduled_at
    for update of candidato skip locked
    limit p_batch
  )
  update public.scheduled_comments sc
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id
  from due
  where sc.id = due.id
  returning sc.*;
end;
$$;

revoke execute on function public.claim_due_posts(text, integer)
  from public, anon, authenticated;
revoke execute on function public.claim_due_comments(text, integer)
  from public, anon, authenticated;

grant execute on function public.claim_due_posts(text, integer) to service_role;
grant execute on function public.claim_due_comments(text, integer) to service_role;

-- ---------------------------------------------------------------
-- 4. As colunas devvit_* são gerenciadas pelo sistema
-- ---------------------------------------------------------------
-- Mesma função da migration original, com as colunas novas incluídas.
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
     or new.publisher is distinct from old.publisher
     or new.devvit_installation_id is distinct from old.devvit_installation_id
     or new.devvit_job_id is distinct from old.devvit_job_id
     or new.devvit_sync_status is distinct from old.devvit_sync_status
     or new.devvit_sync_error is distinct from old.devvit_sync_error
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

-- ---------------------------------------------------------------
-- 5. create_scheduled_post aprende o caminho Devvit
-- ---------------------------------------------------------------
-- Mesmo corpo da versão backend-only, com o publisher explícito. Quando
-- 'devvit', a instalação precisa: existir, ser do owner, estar ativa e ser
-- do MESMO subreddit escolhido — é a barreira no banco para "o subreddit
-- pertence à instalação permitida".
create or replace function public.create_scheduled_post(
  p_owner_id uuid,
  p_post jsonb,
  p_comment jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post_id uuid;
  v_account uuid := (p_post ->> 'reddit_account_id')::uuid;
  v_subreddit uuid := (p_post ->> 'subreddit_id')::uuid;
  v_status text := coalesce(p_post ->> 'status', 'scheduled');
  v_comment_status text := coalesce(p_comment ->> 'status', 'scheduled');
  v_publisher text := coalesce(p_post ->> 'publisher', 'worker');
  v_installation uuid := (p_post ->> 'devvit_installation_id')::uuid;
  v_ok boolean;
begin
  if p_owner_id is null then
    raise exception 'Owner ausente.' using errcode = '42501';
  end if;

  select exists (select 1 from auth.users where id = p_owner_id) into v_ok;
  if not v_ok then
    raise exception 'Owner inválido.' using errcode = '42501';
  end if;

  if v_status not in ('draft', 'scheduled') then
    raise exception 'Estado inicial inválido para uma publicação.'
      using errcode = '42501';
  end if;

  if p_comment is not null and v_comment_status not in ('draft', 'scheduled') then
    raise exception 'Estado inicial inválido para um comentário.'
      using errcode = '42501';
  end if;

  if v_publisher not in ('worker', 'devvit') then
    raise exception 'Publisher inválido.' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.reddit_accounts
    where id = v_account and owner_id = p_owner_id
  ) into v_ok;
  if not v_ok then
    raise exception 'Conta não encontrada.' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.subreddits
    where id = v_subreddit
      and owner_id = p_owner_id
      and reddit_account_id = v_account
  ) into v_ok;
  if not v_ok then
    raise exception 'Comunidade não encontrada para esta conta.'
      using errcode = '42501';
  end if;

  if v_publisher = 'devvit' then
    -- Instalação do owner, ativa e do subreddit escolhido. A comparação usa
    -- o NOME porque a instalação Devvit vive no subreddit, não na conta.
    select exists (
      select 1
      from public.devvit_installations di
      join public.subreddits s on s.id = v_subreddit
      where di.id = v_installation
        and di.owner_id = p_owner_id
        and di.status = 'active'
        and di.subreddit_name = lower(s.name)
    ) into v_ok;
    if not v_ok then
      raise exception 'Instalação Devvit não encontrada para esta comunidade.'
        using errcode = '42501';
    end if;
  elsif v_installation is not null then
    raise exception 'Instalação Devvit só se aplica ao publisher devvit.'
      using errcode = '42501';
  end if;

  insert into public.scheduled_posts (
    owner_id, reddit_account_id, subreddit_id,
    title, url, body, post_kind, flair_id, flair_text,
    nsfw, spoiler, scheduled_at, timezone, status,
    publisher, devvit_installation_id, devvit_sync_status
  )
  values (
    p_owner_id,
    v_account,
    v_subreddit,
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
    v_status,
    v_publisher,
    case when v_publisher = 'devvit' then v_installation end,
    -- O estado inicial da sincronização é sempre 'pending': quem avança é o
    -- bridge, nunca o cliente.
    case when v_publisher = 'devvit' then 'pending' end
  )
  returning id into v_post_id;

  if p_comment is not null then
    insert into public.scheduled_comments (
      owner_id, scheduled_post_id, reddit_account_id,
      body, mode, delay_minutes, scheduled_at, status
    )
    values (
      p_owner_id,
      v_post_id,
      v_account,
      p_comment ->> 'body',
      p_comment ->> 'mode',
      (p_comment ->> 'delay_minutes')::integer,
      (p_comment ->> 'scheduled_at')::timestamptz,
      v_comment_status
    );
  end if;

  return v_post_id;
end;
$$;

revoke execute on function public.create_scheduled_post(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_scheduled_post(uuid, jsonb, jsonb)
  to service_role;
