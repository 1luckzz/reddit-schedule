-- Orçamento de requisições da aplicação junto ao Reddit.
--
-- O limite do Reddit é por client_id, não por conta conectada nem por usuário
-- do painel. Uma linha por client_id, compartilhada por todas as instâncias
-- (web e, a partir do Plano 5, worker).
create table public.reddit_api_budget (
  -- SHA-256 do client_id: a tabela é infraestrutura, não precisa do valor.
  client_id_hash text primary key,
  used integer,
  remaining integer,
  reset_at timestamptz,
  -- Requisições em voo desde o último snapshot. Sem esta coluna, duas
  -- chamadas concorrentes veriam o mesmo `remaining` e reservariam a mesma
  -- capacidade.
  reserved integer not null default 0 check (reserved >= 0),
  paused_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.reddit_api_budget enable row level security;

-- Infraestrutura global: não pertence a nenhum owner e não é exposta ao Data API.
revoke all on public.reddit_api_budget from anon, authenticated;
grant all on public.reddit_api_budget to service_role;

create trigger reddit_api_budget_set_updated_at
  before update on public.reddit_api_budget
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- Reserva atômica de capacidade.
-- ---------------------------------------------------------------
-- O SELECT ... FOR UPDATE serializa chamadas concorrentes: a segunda espera
-- a primeira terminar e enxerga a reserva dela. É isto que impede duas
-- requisições de reservarem a mesma capacidade.
--
-- SECURITY INVOKER de propósito: a função é chamada pelo service_role, que já
-- tem acesso à tabela, e não precisa de privilégio elevado.
create or replace function public.reserve_api_budget(
  p_client_id_hash text,
  p_threshold integer
)
returns table (allowed boolean, remaining integer, paused_until timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.reddit_api_budget;
begin
  insert into public.reddit_api_budget (client_id_hash)
  values (p_client_id_hash)
  on conflict (client_id_hash) do nothing;

  select * into v_row
  from public.reddit_api_budget
  where client_id_hash = p_client_id_hash
  for update;

  -- Janela encerrada: o orçamento anterior e as reservas em voo daquela
  -- janela não significam mais nada.
  if v_row.reset_at is not null and v_row.reset_at <= now() then
    update public.reddit_api_budget
    set used = null, remaining = null, reset_at = null,
        reserved = 0, paused_until = null
    where client_id_hash = p_client_id_hash
    returning * into v_row;
  end if;

  if v_row.paused_until is not null and v_row.paused_until > now() then
    return query select false, v_row.remaining, v_row.paused_until;
    return;
  end if;

  -- remaining nulo significa "ainda não sabemos": reservamos de forma
  -- otimista, e o 429 do Reddit (retryable) é a rede de proteção.
  if v_row.remaining is not null
     and (v_row.remaining - v_row.reserved - 1) < p_threshold then
    update public.reddit_api_budget
    set paused_until = coalesce(v_row.reset_at, now() + interval '60 seconds')
    where client_id_hash = p_client_id_hash
    returning * into v_row;
    return query select false, v_row.remaining, v_row.paused_until;
    return;
  end if;

  update public.reddit_api_budget
  set reserved = v_row.reserved + 1
  where client_id_hash = p_client_id_hash
  returning * into v_row;

  return query select true, v_row.remaining, v_row.paused_until;
end;
$$;

-- Devolve a reserva e sincroniza com os headers, que são a autoridade.
-- Parâmetros nulos significam "sem informação": apenas libera a reserva.
create or replace function public.reconcile_api_budget(
  p_client_id_hash text,
  p_used integer,
  p_remaining integer,
  p_reset_seconds integer,
  p_threshold integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reset_at timestamptz;
begin
  v_reset_at := case
    when p_reset_seconds is not null
      then now() + make_interval(secs => p_reset_seconds)
    else null
  end;

  update public.reddit_api_budget
  set
    used = coalesce(p_used, used),
    remaining = coalesce(p_remaining, remaining),
    reset_at = coalesce(v_reset_at, reset_at),
    reserved = greatest(reserved - 1, 0),
    paused_until = case
      when p_remaining is not null and p_remaining < p_threshold
        then coalesce(v_reset_at, now() + interval '60 seconds')
      else paused_until
    end
  where client_id_hash = p_client_id_hash;
end;
$$;

revoke execute on function public.reserve_api_budget(text, integer)
  from public, anon, authenticated;
revoke execute on function
  public.reconcile_api_budget(text, integer, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.reserve_api_budget(text, integer)
  to service_role;
grant execute on function
  public.reconcile_api_budget(text, integer, integer, integer, integer)
  to service_role;
