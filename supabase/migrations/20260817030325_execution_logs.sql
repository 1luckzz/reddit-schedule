-- ---------------------------------------------------------------
-- Trilha de execução do worker
-- ---------------------------------------------------------------
-- Uma linha por operação tentada contra o Reddit. Serve ao usuário (por que
-- meu post não saiu?) e ao diagnóstico, e é a única fonte de verdade sobre o
-- que o worker fez quando o desfecho ficou ambíguo.
create table public.execution_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- A conta pode ser desconectada e removida sem que o histórico se perca.
  reddit_account_id uuid references public.reddit_accounts (id) on delete set null,
  scheduled_post_id uuid references public.scheduled_posts (id) on delete cascade,
  scheduled_comment_id uuid
    references public.scheduled_comments (id) on delete cascade,

  action text not null,
  http_status integer,
  -- `unknown` não é sinônimo de falha: é o desfecho em que a requisição pode
  -- ter chegado ao Reddit. Ele existe justamente para não ser confundido.
  outcome text not null
    check (outcome in ('success', 'failure', 'retry', 'unknown')),
  error_code text,
  -- Já sanitizado pela aplicação antes de chegar aqui. Nenhum token, senha de
  -- proxy ou URL com credencial deve alcançar esta coluna.
  error_message text,
  duration_ms integer,

  created_at timestamptz not null default now()
);

create index execution_logs_owner_idx
  on public.execution_logs (owner_id, created_at desc);
create index execution_logs_post_idx
  on public.execution_logs (scheduled_post_id);
-- Usado pela limpeza por retenção, que varre por data.
create index execution_logs_created_idx on public.execution_logs (created_at);

alter table public.execution_logs enable row level security;

-- Somente leitura: quem escreve é o worker, via service_role. Um log que o
-- usuário pudesse forjar não serviria para diagnóstico nenhum.
grant select on public.execution_logs to authenticated;
grant all on public.execution_logs to service_role;

create policy "execution_logs_select_own"
  on public.execution_logs for select
  to authenticated
  using ( (select auth.uid()) = owner_id );
