-- ---------------------------------------------------------------
-- Claim atômico de publicações
-- ---------------------------------------------------------------
-- `for update skip locked` serializa: duas instâncias do worker nunca
-- processam o mesmo job ao mesmo tempo. Isso é at-most-one concurrent claim,
-- NÃO exactly-once — a janela entre enviar e gravar o resultado é tratada por
-- submit_attempted_at, não por locking.
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
  update public.scheduled_posts sp
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id
  from (
    select candidato.id
    from public.scheduled_posts candidato
    join public.reddit_accounts ra on ra.id = candidato.reddit_account_id
    where candidato.status = 'scheduled'
      and candidato.scheduled_at <= now()
      and (candidato.next_attempt_at is null
           or candidato.next_attempt_at <= now())
      -- Conta desconectada não publica: o job espera a reconexão.
      and ra.status = 'connected'
      -- Espaçamento mínimo entre publicações da mesma conta.
      and (ra.last_submit_at is null
           or ra.last_submit_at
              + make_interval(secs => ra.min_interval_seconds) <= now())
    order by candidato.scheduled_at
    -- O `of candidato` é essencial: sem ele o Postgres tentaria travar também
    -- as linhas de reddit_accounts do join, e o skip locked passaria a pular
    -- contas em vez de jobs.
    for update of candidato skip locked
    limit p_batch
  ) due
  where sp.id = due.id
  returning sp.*;
end;
$$;

-- ---------------------------------------------------------------
-- Claim atômico de comentários
-- ---------------------------------------------------------------
-- Só é elegível o comentário cujo post pai já publicou e tem fullname.
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
  update public.scheduled_comments sc
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id
  from (
    select candidato.id
    from public.scheduled_comments candidato
    join public.scheduled_posts sp on sp.id = candidato.scheduled_post_id
    join public.reddit_accounts ra on ra.id = candidato.reddit_account_id
    where candidato.status = 'scheduled'
      and candidato.scheduled_at is not null
      and candidato.scheduled_at <= now()
      and (candidato.next_attempt_at is null
           or candidato.next_attempt_at <= now())
      -- O comentário só existe se o post existir no Reddit.
      and sp.status = 'published'
      and sp.reddit_fullname is not null
      and ra.status = 'connected'
    order by candidato.scheduled_at
    for update of candidato skip locked
    limit p_batch
  ) due
  where sc.id = due.id
  returning sc.*;
end;
$$;

-- ---------------------------------------------------------------
-- Materialização do horário dos comentários
-- ---------------------------------------------------------------
-- Nos modos immediate e delay o horário só existe depois que sabemos o
-- published_at real do post. No modo absolute o horário já foi definido na
-- criação e pode estar no passado — nesse caso o comentário fica elegível
-- imediatamente, que é o comportamento desejado.
create or replace function public.materialize_comment_schedule(
  p_post_id uuid,
  p_published_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.scheduled_comments
  set scheduled_at = case
        when mode = 'immediate' then p_published_at
        when mode = 'delay'
          then p_published_at + make_interval(mins => delay_minutes)
        else scheduled_at
      end
  where scheduled_post_id = p_post_id
    and status = 'scheduled'
    and mode in ('immediate', 'delay');
end;
$$;

-- ---------------------------------------------------------------
-- Reaper
-- ---------------------------------------------------------------
-- Job preso em processing significa que o worker morreu. O desfecho depende
-- de submit_attempted_at:
--   nulo     -> a requisição comprovadamente não saiu, volta para a fila;
--   presente -> pode ter chegado ao Reddit, vai para needs_review.
--
-- O reaper NUNCA transforma estado ambíguo em nova submissão.
create or replace function public.reap_stale_jobs(p_timeout_seconds integer)
returns table (kind text, job_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - make_interval(secs => p_timeout_seconds);
begin
  return query
  with devolvidos as (
    update public.scheduled_posts
    set status = 'scheduled', locked_at = null, locked_by = null
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is null
    returning id
  ),
  ambiguos as (
    update public.scheduled_posts
    set status = 'needs_review',
        locked_at = null,
        locked_by = null,
        review_reason = 'OUTCOME_UNKNOWN_WORKER_DIED'
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is not null
    returning id
  ),
  com_devolvidos as (
    update public.scheduled_comments
    set status = 'scheduled', locked_at = null, locked_by = null
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is null
    returning id
  ),
  com_ambiguos as (
    update public.scheduled_comments
    set status = 'needs_review',
        locked_at = null,
        locked_by = null,
        review_reason = 'OUTCOME_UNKNOWN_WORKER_DIED'
    where status = 'processing'
      and locked_at < v_cutoff
      and submit_attempted_at is not null
    returning id
  )
  select 'post'::text, id, 'requeued'::text from devolvidos
  union all
  select 'post'::text, id, 'needs_review'::text from ambiguos
  union all
  select 'comment'::text, id, 'requeued'::text from com_devolvidos
  union all
  select 'comment'::text, id, 'needs_review'::text from com_ambiguos;
end;
$$;

-- ---------------------------------------------------------------
-- Renovação de lock (heartbeat)
-- ---------------------------------------------------------------
-- O worker às vezes precisa esperar mais que o timeout do reaper para
-- terminar um único job — refresh de token lento, proxy ruim, resposta
-- demorada. Sem heartbeat, o reaper recuperaria um job que ainda está vivo e
-- outro worker publicaria o mesmo conteúdo.
--
-- Duas defesas essenciais:
--   1. `locked_by = p_worker_id` — só o dono renova. Um worker não pode
--      prolongar o lock de outro.
--   2. Retorno booleano — falso significa "você perdeu o lock". O chamador
--      deve parar de renovar; continuar seria fingir posse de um job que
--      outra instância já pode ter reivindicado.
create or replace function public.renew_job_lock(
  p_kind text,
  p_job_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean := false;
begin
  if p_kind = 'post' then
    update public.scheduled_posts
    set locked_at = now()
    where id = p_job_id
      and status = 'processing'
      and locked_by = p_worker_id;
    v_ok := found;
  elsif p_kind = 'comment' then
    update public.scheduled_comments
    set locked_at = now()
    where id = p_job_id
      and status = 'processing'
      and locked_by = p_worker_id;
    v_ok := found;
  else
    raise exception 'kind invalido: %', p_kind;
  end if;

  return v_ok;
end;
$$;

-- ---------------------------------------------------------------
-- Nenhuma destas é alcançável pelo Data API.
-- ---------------------------------------------------------------
-- Todas rodam com SECURITY DEFINER e ignoram RLS por construção. Chamáveis
-- por authenticated, permitiriam reivindicar, liberar ou renovar o lock de
-- jobs de qualquer usuário.
revoke execute on function public.claim_due_posts(text, integer)
  from public, anon, authenticated;
revoke execute on function public.claim_due_comments(text, integer)
  from public, anon, authenticated;
revoke execute on function public.reap_stale_jobs(integer)
  from public, anon, authenticated;
revoke execute on function public.renew_job_lock(text, uuid, text)
  from public, anon, authenticated;
revoke execute on function
  public.materialize_comment_schedule(uuid, timestamptz)
  from public, anon, authenticated;

grant execute on function public.claim_due_posts(text, integer) to service_role;
grant execute on function public.claim_due_comments(text, integer) to service_role;
grant execute on function public.reap_stale_jobs(integer) to service_role;
grant execute on function public.renew_job_lock(text, uuid, text) to service_role;
grant execute on function
  public.materialize_comment_schedule(uuid, timestamptz) to service_role;
