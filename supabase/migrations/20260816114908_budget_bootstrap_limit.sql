-- Limite de concorrência enquanto o orçamento é desconhecido.
--
-- Antes, `remaining is null` permitia reservas ilimitadas: quota desconhecida
-- virava concorrência ilimitada, exatamente o oposto de conservador. Agora o
-- comportamento continua otimista — a primeira chamada sai normalmente — mas
-- só uma requisição fica em voo até que os headers X-Ratelimit-* revelem o
-- saldo real.
--
-- Sequência: primeira reserva passa → chamada sai → reconcileBudget grava
-- remaining a partir dos headers → a partir daí a concorrência segue o saldo
-- conhecido. Se a primeira chamada falhar sem headers, a reserva é devolvida
-- e outra tentativa é permitida.

-- O tipo de retorno ganha uma coluna, então a função precisa ser recriada.
drop function if exists public.reserve_api_budget(text, integer);

create function public.reserve_api_budget(
  p_client_id_hash text,
  p_threshold integer
)
returns table (
  allowed boolean,
  remaining integer,
  paused_until timestamptz,
  -- 'ok' | 'paused' | 'bootstrap' — permite mensagens distintas para
  -- "limite atingido" e "ainda descobrindo o limite".
  reason text
)
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
    return query select false, v_row.remaining, v_row.paused_until, 'paused'::text;
    return;
  end if;

  if v_row.remaining is null then
    -- Bootstrap: no máximo uma requisição em voo até conhecermos o saldo.
    if v_row.reserved >= 1 then
      -- Reserva órfã (processo morreu antes de devolver) não pode travar o
      -- sistema para sempre. updated_at é mantido pelo trigger a cada escrita.
      if v_row.updated_at < now() - interval '60 seconds' then
        update public.reddit_api_budget
        set reserved = 0
        where client_id_hash = p_client_id_hash
        returning * into v_row;
      else
        return query
          select false, v_row.remaining, v_row.paused_until, 'bootstrap'::text;
        return;
      end if;
    end if;
  elsif (v_row.remaining - v_row.reserved - 1) < p_threshold then
    update public.reddit_api_budget
    set paused_until = coalesce(v_row.reset_at, now() + interval '60 seconds')
    where client_id_hash = p_client_id_hash
    returning * into v_row;
    return query select false, v_row.remaining, v_row.paused_until, 'paused'::text;
    return;
  end if;

  update public.reddit_api_budget
  set reserved = v_row.reserved + 1
  where client_id_hash = p_client_id_hash
  returning * into v_row;

  return query select true, v_row.remaining, v_row.paused_until, 'ok'::text;
end;
$$;

revoke execute on function public.reserve_api_budget(text, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_api_budget(text, integer)
  to service_role;
