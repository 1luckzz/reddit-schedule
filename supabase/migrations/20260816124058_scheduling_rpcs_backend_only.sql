-- ---------------------------------------------------------------
-- As RPCs de mutação passam a ser exclusivas do backend.
-- ---------------------------------------------------------------
-- Antes, `authenticated` podia executá-las direto pelo Data API. Isso era um
-- caminho para agendar sem passar pela server action — e portanto sem validar
-- `post_requirements`, que depende de uma chamada externa ao Reddit e não pode
-- ser reproduzida dentro do SQL.
--
-- Agora só `service_role` executa. Como o service_role não carrega JWT de
-- usuário, `auth.uid()` seria nulo aqui: o owner passa a ser um parâmetro
-- explícito, obtido pela server action com `requireUser()` — que valida a
-- assinatura do JWT contra as chaves públicas do projeto.
--
-- O parâmetro NÃO é entrada do cliente: quem chama é o backend, e o cliente
-- não tem privilégio para executar estas funções. A verificação de que conta
-- e comunidade pertencem ao owner continua dentro da função.

drop function if exists public.create_scheduled_post(jsonb, jsonb);
drop function if exists public.reschedule_scheduled_post(uuid, timestamptz, text);
drop function if exists public.cancel_scheduled_post(uuid);

create function public.create_scheduled_post(
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

  -- O owner precisa existir de fato: barra um id inventado caso a função
  -- venha a ser chamada de outro ponto no futuro.
  select exists (select 1 from auth.users where id = p_owner_id) into v_ok;
  if not v_ok then
    raise exception 'Owner inválido.' using errcode = '42501';
  end if;

  -- A policy de INSERT restringe o estado inicial, mas SECURITY DEFINER roda
  -- com bypass de RLS: a policy não é aplicada aqui.
  if v_status not in ('draft', 'scheduled') then
    raise exception 'Estado inicial inválido para uma publicação.'
      using errcode = '42501';
  end if;

  if p_comment is not null and v_comment_status not in ('draft', 'scheduled') then
    raise exception 'Estado inicial inválido para um comentário.'
      using errcode = '42501';
  end if;

  -- Conta e comunidade precisam ser do owner. Sob SECURITY DEFINER a RLS não
  -- filtra nada, então esta checagem é a barreira — e as FKs compostas
  -- continuam sendo a última.
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
    -- owner e conta são herdados do post: o comentário sai sempre pela mesma
    -- conta que publicou.
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

create function public.reschedule_scheduled_post(
  p_owner_id uuid,
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
  v_status text;
begin
  if p_owner_id is null then
    raise exception 'Owner ausente.' using errcode = '42501';
  end if;

  select status into v_status
  from public.scheduled_posts
  where id = p_post_id and owner_id = p_owner_id
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

create function public.cancel_scheduled_post(
  p_owner_id uuid,
  p_post_id uuid
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

  select status into v_status
  from public.scheduled_posts
  where id = p_post_id and owner_id = p_owner_id
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

-- ---------------------------------------------------------------
-- Somente o backend executa.
-- ---------------------------------------------------------------
-- O Postgres concede EXECUTE a PUBLIC por padrão em toda função nova, e
-- authenticated herda de PUBLIC — daí o revoke explícito de ambos.
revoke execute on function public.create_scheduled_post(uuid, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function
  public.reschedule_scheduled_post(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
revoke execute on function public.cancel_scheduled_post(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.create_scheduled_post(uuid, jsonb, jsonb)
  to service_role;
grant execute on function
  public.reschedule_scheduled_post(uuid, uuid, timestamptz, text)
  to service_role;
grant execute on function public.cancel_scheduled_post(uuid, uuid)
  to service_role;
