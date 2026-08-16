-- ---------------------------------------------------------------
-- 1. Unicidade GLOBAL de reddit_user_id.
-- ---------------------------------------------------------------
-- Antes, o par (owner_id, reddit_user_id) permitia que dois usuários do painel
-- conectassem a mesma identidade Reddit. Isso quebra três garantias:
--
--   a) configuração de rede: cada linha tem o seu proxy, então a mesma conta
--      Reddit sairia por rotas diferentes conforme quem agendou;
--   b) espaçamento e rate limit por conta: min_interval_seconds e
--      last_submit_at vivem na linha, então duas linhas viram duas filas
--      independentes publicando pela mesma identidade;
--   c) refresh de token: refresh_lock_at também é por linha, então duas linhas
--      permitem refresh simultâneo da mesma identidade — e como o Reddit pode
--      rotacionar o refresh token, uma conexão derrubaria a outra.
--
-- Coordenar isso exigiria mover rede, orçamento e lock para uma entidade por
-- identidade Reddit. Como o produto não precisa de compartilhamento, a
-- unicidade global é a solução simples e correta.
alter table public.reddit_accounts
  drop constraint reddit_accounts_owner_id_reddit_user_id_key;

alter table public.reddit_accounts
  add constraint reddit_accounts_reddit_user_id_key unique (reddit_user_id);

-- ---------------------------------------------------------------
-- 2. Colunas derivadas e de estado ficam fora do alcance do cliente.
-- ---------------------------------------------------------------
-- Primeira barreira: grant por coluna. O usuário autenticado só atualiza o
-- que é dele para configurar. Contas nascem exclusivamente pelo fluxo OAuth
-- (service_role), então INSERT sai de authenticated.
revoke insert, update on public.reddit_accounts from authenticated;
grant update (min_interval_seconds) on public.reddit_accounts to authenticated;

drop policy "reddit_accounts_insert_own" on public.reddit_accounts;

-- Segunda barreira: mesmo que um grant seja afrouxado por engano no futuro,
-- o trigger recusa alteração das colunas gerenciadas internamente.
--
-- current_user vira o dono da função em contextos SECURITY DEFINER, por isso
-- sync_proxy_status() (definer) e o service_role passam, enquanto o role
-- `authenticated` do PostgREST não.
create or replace function public.protect_managed_account_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if new.proxy_enabled is distinct from old.proxy_enabled
     or new.proxy_protocol is distinct from old.proxy_protocol
     or new.proxy_host_masked is distinct from old.proxy_host_masked
     or new.proxy_port is distinct from old.proxy_port
     or new.status is distinct from old.status
     or new.scopes is distinct from old.scopes
     or new.reddit_user_id is distinct from old.reddit_user_id
     or new.username is distinct from old.username
     or new.owner_id is distinct from old.owner_id
     or new.last_error is distinct from old.last_error
     or new.last_submit_at is distinct from old.last_submit_at
     or new.last_authenticated_at is distinct from old.last_authenticated_at
  then
    raise exception
      'Estas colunas são mantidas pelo sistema e não podem ser alteradas diretamente.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.protect_managed_account_columns()
  from public, anon, authenticated;

create trigger reddit_accounts_protect_managed_columns
  before update on public.reddit_accounts
  for each row execute function public.protect_managed_account_columns();

-- ---------------------------------------------------------------
-- 3. Remover privilégios herdados que ninguém concedeu de propósito.
-- ---------------------------------------------------------------
-- O Supabase mantém um ALTER DEFAULT PRIVILEGES que concede TRUNCATE,
-- REFERENCES e TRIGGER a anon e authenticated em toda tabela nova do schema
-- public. TRUNCATE é o que preocupa: ele ignora RLS por completo, então uma
-- única superfície que o alcance esvazia a tabela inteira, políticas ou não.
--
-- O PostgREST não expõe TRUNCATE hoje, mas o privilégio não serve a nada aqui
-- e o custo de removê-lo é zero.
revoke truncate, references, trigger on all tables in schema public
  from anon, authenticated;

-- E o mesmo para as tabelas que ainda serão criadas pelas próximas migrations.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

-- O painel é privado: anon não tem nada a fazer em nenhuma tabela.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
