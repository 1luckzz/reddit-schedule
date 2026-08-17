-- ---------------------------------------------------------------
-- Resolução manual de um job em needs_review
-- ---------------------------------------------------------------
-- Exclusiva do backend, como as demais RPCs de mutação: a decisão vem de uma
-- server action que já verificou a sessão e passa o owner derivado dela.
--
-- Esta função NUNCA republica. Ela registra o que a pessoa decidiu depois de
-- olhar o Reddit — é o único caminho de saída de `needs_review`, e existe
-- justamente porque o sistema se recusa a adivinhar sozinho.
create or replace function public.resolve_needs_review(
  p_owner_id uuid,
  p_post_id uuid,
  p_decision text,
  p_reddit_post_id text default null,
  p_reddit_fullname text default null,
  p_permalink text default null
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

  if p_decision not in ('published', 'failed', 'cancelled') then
    raise exception 'Decisão inválida.' using errcode = '22023';
  end if;

  -- O owner entra na cláusula, e não só numa checagem posterior: com
  -- SECURITY DEFINER a RLS não se aplica, então a posse precisa estar no
  -- próprio predicado. Um post de outro dono simplesmente não é encontrado.
  select status into v_status
  from public.scheduled_posts
  where id = p_post_id and owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'Publicação não encontrada.' using errcode = '42501';
  end if;

  if v_status <> 'needs_review' then
    raise exception 'Só é possível resolver publicações em revisão.'
      using errcode = '42501';
  end if;

  -- Marcar como publicada exige o identificador: sem ele não há o que
  -- registrar, o histórico ficaria mentindo, e o comentário programado não
  -- teria onde ser feito.
  if p_decision = 'published' and
     (p_reddit_post_id is null or p_reddit_fullname is null) then
    raise exception 'Informe a publicação encontrada no Reddit.'
      using errcode = '22023';
  end if;

  update public.scheduled_posts
  set status = p_decision,
      reddit_post_id = coalesce(p_reddit_post_id, reddit_post_id),
      reddit_fullname = coalesce(p_reddit_fullname, reddit_fullname),
      reddit_permalink = coalesce(p_permalink, reddit_permalink),
      published_at = case
        when p_decision = 'published' then coalesce(published_at, now())
        else published_at
      end,
      resolved_by = p_owner_id,
      resolved_at = now(),
      review_reason = null
  where id = p_post_id;

  -- Resolvido como publicado: os comentários programados voltam a fazer
  -- sentido e ganham horário a partir de agora. Os de horário absoluto já
  -- vencido ficam elegíveis imediatamente, como em qualquer publicação.
  if p_decision = 'published' then
    perform public.materialize_comment_schedule(p_post_id, now());
  else
    -- Sem publicação, não há onde comentar. Cancelar é melhor que deixar os
    -- comentários pendentes para sempre esperando um post que não existe.
    update public.scheduled_comments
    set status = 'cancelled'
    where scheduled_post_id = p_post_id
      and status in ('draft', 'scheduled');
  end if;
end;
$$;

revoke execute on function
  public.resolve_needs_review(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.resolve_needs_review(uuid, uuid, text, text, text, text)
  to service_role;
