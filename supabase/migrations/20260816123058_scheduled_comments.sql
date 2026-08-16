create table public.scheduled_comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  scheduled_post_id uuid not null,
  reddit_account_id uuid not null,

  body text not null,

  -- immediate: assim que o post publicar
  -- delay: X minutos depois da publicação real
  -- absolute: em um horário fixo, desde que o post já tenha publicado
  mode text not null check (mode in ('immediate', 'delay', 'absolute')),
  delay_minutes integer check (delay_minutes >= 0),
  -- Nulo nos modos immediate e delay até o post publicar: o horário só existe
  -- depois que sabemos published_at real.
  --
  -- No modo absolute, o horário é definido na criação e PODE estar no passado
  -- quando o post finalmente publicar — por atraso na fila, retentativa ou
  -- revisão manual. Nesse caso o comentário fica elegível imediatamente após
  -- a publicação, em vez de ser descartado: o usuário pediu "às 15h", e
  -- publicar às 15h30 não torna o comentário indesejado. Não há constraint
  -- exigindo horário futuro, e é de propósito.
  scheduled_at timestamptz,

  status text not null default 'scheduled'
    check (status in (
      'draft', 'scheduled', 'processing',
      'published', 'failed', 'cancelled', 'needs_review'
    )),

  reddit_comment_id text,
  reddit_permalink text,
  error_code text,
  error_message text,
  retry_count integer not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  submit_attempted_at timestamptz,
  review_reason text,
  resolved_by uuid references auth.users (id),
  resolved_at timestamptz,
  published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint corpo_nao_vazio check (length(btrim(body)) > 0),
  constraint modo_coerente check (
    (mode = 'immediate' and delay_minutes is null)
    or (mode = 'delay' and delay_minutes is not null)
    or (mode = 'absolute' and scheduled_at is not null)
  ),

  foreign key (scheduled_post_id, owner_id)
    references public.scheduled_posts (id, owner_id) on delete cascade,
  -- O comentário sai sempre pela MESMA conta que publicou o post.
  foreign key (scheduled_post_id, reddit_account_id)
    references public.scheduled_posts (id, reddit_account_id) on delete cascade
);

create index scheduled_comments_post_idx
  on public.scheduled_comments (scheduled_post_id);

create index scheduled_comments_due_idx
  on public.scheduled_comments (scheduled_at)
  where status = 'scheduled';

create index scheduled_comments_owner_idx
  on public.scheduled_comments (owner_id);

alter table public.scheduled_comments enable row level security;

-- Somente leitura, pelo mesmo motivo de scheduled_posts: o comentário nasce
-- junto do post, na função transacional, e é cancelado junto com ele.
grant select on public.scheduled_comments to authenticated;
grant all on public.scheduled_comments to service_role;

create policy "scheduled_comments_select_own"
  on public.scheduled_comments for select
  to authenticated
  using ( (select auth.uid()) = owner_id );

-- Policies de escrita sem grant correspondente: segunda barreira.
create policy "scheduled_comments_insert_own"
  on public.scheduled_comments for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and status in ('draft', 'scheduled')
  );

create policy "scheduled_comments_update_own"
  on public.scheduled_comments for update
  to authenticated
  using ( (select auth.uid()) = owner_id )
  with check ( (select auth.uid()) = owner_id );

create trigger scheduled_comments_set_updated_at
  before update on public.scheduled_comments
  for each row execute function public.set_updated_at();

-- A mesma máquina de estados dos posts vale para comentários.
create or replace function public.enforce_comment_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_admin boolean := current_user in ('service_role', 'postgres', 'supabase_admin');
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'needs_review'
     and new.status not in ('published', 'failed', 'cancelled') then
    raise exception
      'De needs_review só é possível resolver manualmente.'
      using errcode = '23514';
  end if;

  if old.status in ('published', 'cancelled') then
    raise exception 'Comentário concluído ou cancelado não muda de estado.'
      using errcode = '23514';
  end if;

  if old.status = 'processing' and new.status = 'scheduled'
     and old.submit_attempted_at is not null then
    raise exception
      'Comentário com envio já tentado não volta para a fila.'
      using errcode = '23514';
  end if;

  if not v_admin then
    if new.status <> 'cancelled'
       or old.status not in ('draft', 'scheduled') then
      raise exception
        'Só é possível cancelar comentários que ainda não entraram em execução.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_comment_transition()
  from public, anon, authenticated;

create trigger scheduled_comments_enforce_transition
  before update on public.scheduled_comments
  for each row execute function public.enforce_comment_transition();
