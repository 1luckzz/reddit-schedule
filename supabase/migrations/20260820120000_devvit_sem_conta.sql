-- ---------------------------------------------------------------
-- Caminho Devvit independente de conta Reddit
-- ---------------------------------------------------------------
-- O acesso à Reddit Data API foi negado, então o caminho Devvit não pode
-- depender de conta conectada nem de subreddits sincronizados. Um post
-- 'devvit' passa a ter como origem APENAS a instalação; conta e comunidade
-- legacy ficam opcionais. O caminho 'worker' não muda em nada: a constraint
-- abaixo mantém conta e comunidade obrigatórias para ele.

-- 1. Conta e comunidade viram opcionais SOMENTE para o caminho Devvit ------
alter table public.scheduled_posts
  alter column reddit_account_id drop not null,
  alter column subreddit_id drop not null;

alter table public.scheduled_posts
  add constraint origem_coerente check (
    (publisher = 'worker'
       and reddit_account_id is not null
       and subreddit_id is not null)
    or publisher = 'devvit'
  );

alter table public.scheduled_comments
  alter column reddit_account_id drop not null;

-- Comentário sem conta só existe sob um post Devvit. CHECK não enxerga outra
-- tabela, então a regra vive num trigger.
create or replace function public.enforce_comment_origin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_publisher text;
begin
  if new.reddit_account_id is null then
    select publisher into v_publisher
    from public.scheduled_posts
    where id = new.scheduled_post_id;

    if v_publisher is distinct from 'devvit' then
      raise exception
        'Comentário sem conta Reddit só existe no caminho Devvit.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_comment_origin()
  from public, anon, authenticated;

create trigger scheduled_comments_enforce_origin
  before insert or update on public.scheduled_comments
  for each row execute function public.enforce_comment_origin();

-- 2. Instalação com histórico não pode ser apagada -------------------------
-- Troca o CASCADE por NO ACTION: apagar uma instalação com agendamentos passa
-- a falhar (desativação é status='disabled'), preservando fila e histórico.
-- NO ACTION (e não RESTRICT) de propósito: a checagem no fim do statement
-- permite que o cascade de auth.users continue apagando usuário, instalações
-- e posts numa única operação.
alter table public.scheduled_posts
  drop constraint scheduled_posts_devvit_installation_fkey;

alter table public.scheduled_posts
  add constraint scheduled_posts_devvit_installation_fkey
    foreign key (devvit_installation_id, owner_id)
    references public.devvit_installations (id, owner_id);

-- 3. create_scheduled_post: o caminho Devvit dispensa conta e comunidade ---
-- Para 'devvit', conta e comunidade agora são PROIBIDAS no payload: a origem
-- canônica é a instalação, validada por owner e status. O caminho 'worker'
-- permanece byte a byte com as mesmas validações de antes.
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

  if v_publisher = 'devvit' then
    -- A origem é exclusivamente a instalação: conta e comunidade legacy não
    -- entram neste caminho, nem por engano.
    if v_account is not null or v_subreddit is not null then
      raise exception
        'Publicação Devvit não referencia conta nem comunidade legacy.'
        using errcode = '42501';
    end if;

    select exists (
      select 1 from public.devvit_installations
      where id = v_installation
        and owner_id = p_owner_id
        and status = 'active'
    ) into v_ok;
    if not v_ok then
      raise exception 'Instalação Devvit não encontrada para esta comunidade.'
        using errcode = '42501';
    end if;
  else
    if v_installation is not null then
      raise exception 'Instalação Devvit só se aplica ao publisher devvit.'
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
    -- No caminho worker o comentário herda a conta do post; no Devvit ele é
    -- publicado pelo app e não tem conta.
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
