-- Perfil do usuário do painel. Uma linha por auth.users.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'America/Sao_Paulo',
  log_retention_days integer not null default 30
    check (log_retention_days between 1 and 365),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Grants tornam a tabela alcançável pelo Data API; as policies acima decidem
-- quais linhas cada usuário enxerga. São controles distintos: sem grant, nem o
-- dono da linha lê. `anon` não recebe nada — o painel é privado.
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ( (select auth.uid()) = id );

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ( (select auth.uid()) = id )
  with check ( (select auth.uid()) = id );

-- Sem policy de INSERT nem DELETE: as linhas nascem pelo trigger de signup
-- e morrem pelo cascade de auth.users.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Cria o profile no signup. Precisa de security definer porque roda no
-- contexto do insert em auth.users, onde o usuário ainda não tem sessão.
-- Não recebe entrada do usuário: usa apenas new.id.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- O Postgres concede EXECUTE a PUBLIC por padrão, o que tornaria esta
-- função security definer um endpoint chamável por anon e authenticated.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
