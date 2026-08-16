-- Cria publicação e comentário numa única transação.
--
-- Dois inserts sequenciais da aplicação deixariam um post órfão se o segundo
-- falhasse, e o worker publicaria sem o comentário que o usuário pediu.
--
-- SECURITY DEFINER: `authenticated` não tem INSERT nas tabelas, para não
-- poder contornar as regras do domínio pelo Data API. Em troca, a checagem de
-- posse passa a ser responsabilidade desta função — a RLS não a faz aqui.
create or replace function public.create_scheduled_post(
  p_post jsonb,
  p_comment jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_post_id uuid;
  v_account uuid := (p_post ->> 'reddit_account_id')::uuid;
  v_subreddit uuid := (p_post ->> 'subreddit_id')::uuid;
  v_status text := coalesce(p_post ->> 'status', 'scheduled');
  v_comment_status text := coalesce(p_comment ->> 'status', 'scheduled');
  v_ok boolean;
begin
  if v_owner is null then
    raise exception 'Sessão ausente.' using errcode = '42501';
  end if;

  -- A policy de INSERT restringe o estado inicial, mas SECURITY DEFINER roda
  -- com bypass de RLS: a policy não é aplicada aqui. Sem esta checagem, o
  -- cliente poderia criar uma publicação já como `published` e nunca
  -- publicá-la de fato — ou como `processing`, confundindo o worker.
  if v_status not in ('draft', 'scheduled') then
    raise exception 'Estado inicial inválido para uma publicação.'
      using errcode = '42501';
  end if;

  if p_comment is not null and v_comment_status not in ('draft', 'scheduled') then
    raise exception 'Estado inicial inválido para um comentário.'
      using errcode = '42501';
  end if;

  -- Conta e comunidade precisam ser do usuário da sessão. Sob SECURITY
  -- DEFINER a RLS não filtra nada, então esta checagem é a barreira — e as
  -- FKs compostas continuam sendo a última.
  select exists (
    select 1 from public.reddit_accounts
    where id = v_account and owner_id = v_owner
  ) into v_ok;
  if not v_ok then
    raise exception 'Conta não encontrada.' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.subreddits
    where id = v_subreddit
      and owner_id = v_owner
      and reddit_account_id = v_account
  ) into v_ok;
  if not v_ok then
    raise exception 'Comunidade não encontrada para esta conta.'
      using errcode = '42501';
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
      v_comment_status
    );
  end if;

  return v_post_id;
end;
$$;

-- ---------------------------------------------------------------
-- Reagendar
-- ---------------------------------------------------------------
-- Recebe o instante já convertido para UTC: a decisão de qual ocorrência usar
-- num horário ambíguo é do usuário, e acontece antes de chegar aqui.
create or replace function public.reschedule_scheduled_post(
  p_post_id uuid,
  p_scheduled_at timestamptz,
  p_timezone text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_status text;
begin
  if v_owner is null then
    raise exception 'Sessão ausente.' using errcode = '42501';
  end if;

  select status into v_status
  from public.scheduled_posts
  where id = p_post_id and owner_id = v_owner
  for update;

  if not found then
    raise exception 'Publicação não encontrada.' using errcode = '42501';
  end if;

  if v_status not in ('draft', 'scheduled') then
    raise exception 'Só é possível reagendar publicações que ainda não entraram em execução.'
      using errcode = '42501';
  end if;

  -- Apenas as colunas de agendamento: nada de conteúdo, estado ou execução.
  update public.scheduled_posts
  set scheduled_at = p_scheduled_at, timezone = p_timezone
  where id = p_post_id;
end;
$$;

-- ---------------------------------------------------------------
-- Cancelar
-- ---------------------------------------------------------------
create or replace function public.cancel_scheduled_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := (select auth.uid());
  v_status text;
begin
  if v_owner is null then
    raise exception 'Sessão ausente.' using errcode = '42501';
  end if;

  select status into v_status
  from public.scheduled_posts
  where id = p_post_id and owner_id = v_owner
  for update;

  if not found then
    raise exception 'Publicação não encontrada.' using errcode = '42501';
  end if;

  if v_status not in ('draft', 'scheduled') then
    raise exception 'Só é possível cancelar publicações que ainda não entraram em execução.'
      using errcode = '42501';
  end if;

  update public.scheduled_posts
  set status = 'cancelled'
  where id = p_post_id;

  -- Comentário sem post não faz sentido. Só os que ainda não executaram.
  update public.scheduled_comments
  set status = 'cancelled'
  where scheduled_post_id = p_post_id
    and status in ('draft', 'scheduled');
end;
$$;

revoke execute on function public.create_scheduled_post(jsonb, jsonb)
  from public, anon;
revoke execute on function
  public.reschedule_scheduled_post(uuid, timestamptz, text) from public, anon;
revoke execute on function public.cancel_scheduled_post(uuid) from public, anon;

grant execute on function public.create_scheduled_post(jsonb, jsonb)
  to authenticated, service_role;
grant execute on function
  public.reschedule_scheduled_post(uuid, timestamptz, text)
  to authenticated, service_role;
grant execute on function public.cancel_scheduled_post(uuid)
  to authenticated, service_role;
