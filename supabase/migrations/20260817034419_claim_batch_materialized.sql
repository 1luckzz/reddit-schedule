-- ---------------------------------------------------------------
-- O lote precisa de uma CTE materializada, não de uma subquery
-- ---------------------------------------------------------------
-- Sintoma: `claim_due_posts(worker, 2)` devolvia 3 linhas — mas só depois de
-- algumas chamadas na mesma conexão.
--
-- Causa: o plpgsql troca o plano específico pelo genérico depois de algumas
-- execuções. No plano genérico o `p_batch` é opaco para o planejador, que
-- pode colocar a subquery com `for update ... limit` no lado INTERNO de um
-- nested loop. Ali ela é reexecutada uma vez por linha externa, e cada
-- reexecução trava e atualiza um lote novo — pulando as linhas já travadas
-- justamente por causa do `skip locked`.
--
-- Por isso o defeito não aparecia em chamada isolada nem no EXPLAIN de uma
-- consulta com literal: os dois usam o plano específico.
--
-- Correção: `with ... as materialized` obriga a avaliação única. O lote deixa
-- de depender da escolha do planejador, que é o que um claim precisa.
--
-- Consequência prática de não corrigir: o worker processaria mais jobs por
-- ciclo do que WORKER_BATCH_SIZE permite, furando o controle de vazão que
-- protege o rate limit do Reddit.

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
      -- O comentário só existe se o post existir no Reddit.
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

-- `create or replace` preserva os privilégios existentes, mas repetimos os
-- revokes: uma função recriada por engano sem eles seria alcançável pelo
-- Data API, e o custo de repetir é zero.
revoke execute on function public.claim_due_posts(text, integer)
  from public, anon, authenticated;
revoke execute on function public.claim_due_comments(text, integer)
  from public, anon, authenticated;

grant execute on function public.claim_due_posts(text, integer) to service_role;
grant execute on function public.claim_due_comments(text, integer) to service_role;
