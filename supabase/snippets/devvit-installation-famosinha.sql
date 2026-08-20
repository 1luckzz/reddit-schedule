-- Registro da instalação Devvit de r/Famosinha_BR.
--
-- Identificadores capturados por métodos oficiais em 2026-08-20:
--   subreddit_name       'famosinha_br'  (minúsculo, exigido pela constraint;
--                         nomes de subreddit são case-insensitive no Reddit)
--   app_slug             'grapepos2'     (slug do app na plataforma Devvit)
--   install_location_id  't5_ji4dpk'     (context.subredditId do app rodando
--                         instalado em r/Famosinha_BR)
--
-- Executar no projeto REMOTO somente quando a fase de produção começar, com
-- service_role (a tabela não aceita escrita de authenticated). O upsert torna
-- a reexecução segura.
insert into public.devvit_installations
  (owner_id, subreddit_name, app_slug, install_location_id, status)
select u.id, 'famosinha_br', 'grapepos2', 't5_ji4dpk', 'active'
from auth.users u
where u.email = 'snopeym@gmail.com'
on conflict (owner_id, subreddit_name) do update
  set app_slug = excluded.app_slug,
      install_location_id = excluded.install_location_id,
      status = 'active';
