-- Rollback completo da migration 20260820100000_devvit_publisher.sql.
--
-- Seguro porque a migration não destruiu nada: aqui apenas removemos o que
-- ela criou e restauramos os corpos ANTERIORES das funções (copiados das
-- migrations 20260817034419, 20260816122512 e 20260816124058). Posts que
-- tenham nascido com publisher='devvit' perdem essas colunas — se existirem,
-- exporte-os antes.

begin;

-- 1. Funções voltam aos corpos anteriores ------------------------------

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

  insert into public.scheduled_posts (
    owner_id, reddit_account_id, subreddit_id,
    title, url, body, post_kind, flair_id, flair_text,
    nsfw, spoiler, scheduled_at, timezone, status
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
    v_status
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

-- 2. Colunas e tabela criadas pela migration ---------------------------

drop index if exists public.scheduled_posts_devvit_sync_idx;

alter table public.scheduled_posts
  drop constraint if exists devvit_coerente,
  drop constraint if exists scheduled_posts_devvit_installation_fkey,
  drop column if exists publisher,
  drop column if exists devvit_installation_id,
  drop column if exists devvit_job_id,
  drop column if exists devvit_sync_status,
  drop column if exists devvit_sync_error;

drop table if exists public.devvit_installations;

-- 3. Remove o registro da migration ------------------------------------
delete from supabase_migrations.schema_migrations
where version = '20260820100000';

commit;
