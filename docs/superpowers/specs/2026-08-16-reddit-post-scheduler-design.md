# Reddit Post Scheduler — Design

Data: 2026-08-16
Status: aprovado para planejamento

## 1. Objetivo

Painel privado multi-usuário para agendar e publicar automaticamente no Reddit,
usando exclusivamente a API/OAuth oficial. Cada usuário conecta múltiplas contas
Reddit próprias (que moderam as próprias comunidades), cria publicações, escolhe
conta, comunidade, data e horário, e o sistema publica sozinho no momento
marcado — opcionalmente adicionando um comentário logo em seguida.

### Fora de escopo, por decisão explícita

Nada de browser automation, Selenium, Playwright para postar, login por senha,
manipulação de fingerprint, bypass de CAPTCHA, ban evasion, rotação de proxies
para escapar de bloqueios, criação automática de contas, ocultação de
comportamento coordenado ou bypass de rate limit. Quando o Reddit rejeita uma
ação, o sistema registra o erro e para.

## 2. Decisões tomadas

| Decisão | Escolha |
|---|---|
| Worker | Processo Node standalone (Docker no VPS), loop próprio |
| Tenancy | Multi-usuário desde o início, RLS por `owner_id` |
| App OAuth Reddit | Ainda não criado — README traz o passo a passo |
| Supabase | Projeto novo `reddit-scheduler`, região sa-east-1 |
| Deploy web | Vercel |
| Deploy worker | VPS via Docker |
| Testes | Unit + integração (Vitest + Supabase local via Docker), sem E2E |

## 3. Stack

- Next.js (App Router) + React + TypeScript strict
- Tailwind CSS v4 + primitivas Radix UI + lucide-react
- Supabase: Postgres + Auth (`@supabase/ssr`)
- `undici` para HTTP (necessário para `ProxyAgent` por conta)
- `zod` para validação, `date-fns` + `@date-fns/tz` para timezone
- `vitest` para testes, `tsx` para rodar o worker
- Node 24 LTS

## 4. Arquitetura

Repositório único, dois processos, uma única camada de integração compartilhada.

```
Browser ──> Next.js (server actions / route handlers) ──> Supabase Postgres
   (Vercel)                                                    ▲
                                                               │ claim atômico
                                        worker/index.ts ───────┘
                                        (VPS, Docker)   └──> oauth.reddit.com
```

O worker importa `src/lib/**` via alias TypeScript; não há duplicação de lógica
de publicação. O build do worker é um `Dockerfile.worker` separado.

### Estrutura de diretórios

```
src/
  app/
    (auth)/login/
    (dashboard)/dashboard | new | calendar | queue | history
                | accounts | communities | logs | settings
    api/reddit/authorize/route.ts
    api/reddit/callback/route.ts
    api/health/route.ts
  components/            ui/ (primitivas) + domínio
  lib/
    reddit/   auth.ts client.ts reddit-client-factory.ts posts.ts
              comments.ts communities.ts flairs.ts requirements.ts
              errors.ts types.ts ratelimit.ts
    crypto/   aes-gcm.ts
    supabase/ server.ts admin.ts middleware.ts client.ts
    scheduling/ payload-builder.ts validation.ts schedule.ts
    logging/  sanitize.ts execution-log.ts
    config/   env.ts (Zod sobre process.env)
worker/
  index.ts post-runner.ts comment-runner.ts reaper.ts lock.ts
supabase/migrations/
docs/
tests/
```

### Regra de fronteira

Nenhum componente React chama o Reddit ou toca em tokens. Todo acesso à API
passa por `src/lib/reddit/`, invocado apenas de server actions, route handlers
ou do worker.

## 5. Modelo de dados

Todas as tabelas de domínio têm `owner_id uuid not null references auth.users(id)`,
`created_at`, `updated_at` (trigger), e RLS habilitada com policy
`owner_id = auth.uid()`.

### 5.1 Isolamento de segredos

Tokens e credenciais de proxy vivem em tabelas satélite com **RLS habilitada e
zero policies**: o role `authenticated` não lê nem uma linha, mesmo com o
anon key vazado. Somente `service_role` (server actions e worker) acessa.

| Tabela | Campos principais | Frontend |
|---|---|---|
| `profiles` | `id` (=auth.users.id), `timezone` default `America/Sao_Paulo`, `log_retention_days` | leitura/escrita própria |
| `reddit_accounts` | `id`, `owner_id`, `reddit_user_id` unique por owner, `username`, `scopes text[]`, `status` (`connected`/`expired`/`disconnected`/`revoked`), `last_authenticated_at`, `last_error` | leitura própria |
| `reddit_account_secrets` | `reddit_account_id` PK/FK, `access_token_enc`, `refresh_token_enc`, `access_token_expires_at`, `refresh_lock_at` | **nenhum** |
| `reddit_account_network_configs` | `reddit_account_id` PK/FK, `proxy_enabled`, `proxy_protocol` (`http`/`https`/`socks5`), `proxy_host`, `proxy_port`, `proxy_username`, `proxy_password_enc` | **nenhum** (escrita via server action; UI lê só flags derivadas de uma view) |
| `subreddits` | `id`, `owner_id`, `reddit_account_id`, `subreddit_id` (t5_…), `name`, `display_name`, `url`, `over_18`, `status`, `last_synced_at`; unique `(reddit_account_id, subreddit_id)` | leitura própria |
| `scheduled_posts` | ver 5.2 | leitura/escrita própria |
| `scheduled_comments` | ver 5.3 | leitura/escrita própria |
| `execution_logs` | `id`, `owner_id`, `reddit_account_id`, `scheduled_post_id`, `scheduled_comment_id`, `action`, `http_status`, `outcome` (`success`/`failure`/`retry`), `error_code`, `error_message` (sanitizado), `duration_ms`, `created_at` | leitura própria |

Uma view `reddit_account_network_status` expõe apenas
`(reddit_account_id, proxy_enabled, proxy_protocol, proxy_host_masked, proxy_port)`
para a UI — host mascarado, nunca usuário ou senha.

### 5.2 `scheduled_posts`

`id`, `owner_id`, `reddit_account_id`, `subreddit_id`, `title`, `url`, `body`,
`flair_id`, `flair_text`, `post_kind` (`link`/`self`), `nsfw`, `spoiler`,
`scheduled_at timestamptz`, `timezone`, `status`, `reddit_post_id`,
`reddit_fullname`, `reddit_permalink`, `error_code`, `error_message`,
`retry_count`, `next_attempt_at`, `locked_at`, `locked_by`, `published_at`,
`created_at`, `updated_at`.

Status: `draft` → `scheduled` → `processing` → `published` | `failed` | `cancelled`.

Índices: `(status, scheduled_at)` parcial para `status='scheduled'`;
`(owner_id, scheduled_at desc)`; `(reddit_account_id, status)`.
Unique parcial em `reddit_post_id` where not null.

### 5.3 `scheduled_comments`

`id`, `owner_id`, `scheduled_post_id` FK, `reddit_account_id`, `body`,
`mode` (`immediate` / `delay` / `absolute`), `delay_minutes`, `scheduled_at`,
`status` (mesma máquina de estados), `reddit_comment_id`, `reddit_permalink`,
`error_code`, `error_message`, `retry_count`, `next_attempt_at`, `locked_at`,
`locked_by`, `published_at`.

Regra invariante: só é elegível quando o post pai tem `reddit_post_id` não nulo
e status `published`. Em modo `immediate`/`delay`, `scheduled_at` do comentário é
recalculado a partir do `published_at` real do post.

### 5.4 Timezone

`scheduled_at` é sempre `timestamptz` (UTC no banco). A coluna `timezone` guarda
o fuso escolhido apenas para exibir e reeditar corretamente. Conversão acontece
na borda, com `@date-fns/tz`.

## 6. Autenticação do painel

Supabase Auth (email + senha). `middleware.ts` refresca a sessão e protege
`/dashboard/*` e todas as rotas do grupo autenticado, redirecionando para
`/login`. Trigger `on auth.users insert` cria a linha em `profiles` com o
timezone padrão.

## 7. OAuth Reddit

Fluxo *authorization code* com app confidencial (tipo **web app**):

1. `GET /api/reddit/authorize` gera `state` de 32 bytes, grava em cookie
   `httpOnly`, `SameSite=Lax`, TTL 10 min, e redireciona para
   `https://www.reddit.com/api/v1/authorize` com `client_id`, `response_type=code`,
   `state`, `redirect_uri`, `duration=permanent`, `scope`.
2. `GET /api/reddit/callback` valida o `state` contra o cookie (rejeita se
   ausente/divergente), troca o `code` em
   `https://www.reddit.com/api/v1/access_token` com HTTP Basic
   (`client_id:client_secret`), busca `/api/v1/me` para obter `id` e `name`,
   cifra e persiste os tokens, e faz upsert em `reddit_accounts`.

Escopos: `identity mysubreddits submit read flair edit history`.

Chamadas de API sempre em `https://oauth.reddit.com` com
`Authorization: bearer <token>` e `User-Agent` obrigatório no formato
`web:<app-id>:<versão> (by /u/<seu-usuário>)`.

**PKCE não é suportado pelo Reddit** — a documentação oficial do OAuth2 não o
implementa. A proteção equivalente disponível é o `state` validado por cookie
httpOnly, que é o que implementamos. Isso está registrado na seção de limitações.

### Refresh

`RedditClientFactory` renova quando faltam menos de 120 s para expirar, usando
`grant_type=refresh_token`. Um lock por conta (`refresh_lock_at`) evita dois
refreshes simultâneos. Refresh token inválido → conta vira `disconnected`,
jobs pendentes daquela conta falham com mensagem humana pedindo reconexão.

## 8. `RedditClientFactory` e configuração de rede

`getRedditClient(accountId)`:

1. carrega `reddit_account_secrets` (service_role) e decifra;
2. renova o access token se necessário e persiste;
3. carrega `reddit_account_network_configs`; se `proxy_enabled`, monta um
   `undici.ProxyAgent` com aquelas credenciais; senão usa o dispatcher global;
4. devolve um cliente que injeta `Authorization` e `User-Agent`, lê
   `X-Ratelimit-Used/Remaining/Reset`, respeita `Retry-After` em 429 e converte
   respostas em erros tipados.

Proxy é tratado como configuração de rede e nada mais: sem rotação automática,
sem troca de rota após bloqueio, sem retry de 403. Credenciais nunca saem do
backend, nunca vão para logs, nunca chegam ao navegador.

### Erros tipados (`errors.ts`)

`TokenExpiredError`, `RefreshInvalidError`, `AccountDisconnectedError`,
`SubredditNotFoundError`, `NoPermissionError`, `FlairRequiredError`,
`RateLimitedError` (com `retryAfterSeconds`), `ContentRejectedError`,
`PostRemovedError`, `NetworkError`, `ProxyUnavailableError`,
`RedditUnavailableError`.

Cada um carrega `code`, `retryable: boolean` e uma mensagem em português para o
dashboard. Exemplo: *"Falha ao publicar: sua conta não possui mais permissão
para publicar nessa comunidade."*

## 9. Endpoints oficiais utilizados

| Uso | Endpoint | Escopo |
|---|---|---|
| Identidade | `GET /api/v1/me` | identity |
| Comunidades moderadas | `GET /subreddits/mine/moderator?limit=100&after=` | mysubreddits |
| Requisitos de post | `GET /api/v1/{subreddit}/post_requirements` | submit |
| Flairs | `GET /r/{sub}/api/link_flair_v2` | flair |
| Publicar | `POST /api/submit` | submit |
| Comentar | `POST /api/comment` | submit |
| Aplicar flair pós-publicação | `POST /r/{sub}/api/selectflair` | flair |

## 10. Construção do payload de publicação

`post_requirements` é consultado no agendamento (para validar o formulário) e
novamente imediatamente antes de publicar (as regras podem ter mudado). Campos
relevantes: `title_text_min_length`, `title_text_max_length`,
`body_restriction_policy` (`required` | `notAllowed` | `none`),
`is_flair_required`, `domain_whitelist`, `domain_blacklist`,
`title_blacklisted_strings`, `body_blacklisted_strings`.

| Entrada do usuário | `kind` enviado | Comportamento |
|---|---|---|
| Título + link | `link` com `url` | direto |
| Título + texto | `self` com `text` | direto |
| Título + link + texto | `link` com `url` | A API do Reddit não aceita corpo junto de um link post. A UI avisa e oferece enviar o texto como comentário automático (recurso da seção 12), usando endpoint oficial. |
| Link em sub com `body_restriction_policy = required` | — | bloqueado no formulário, com o motivo |
| Texto em sub com `body_restriction_policy = notAllowed` | — | bloqueado no formulário |
| Sub com `is_flair_required` | — | flair torna-se obrigatório |

Flair é enviado em `flair_id` no próprio `/api/submit`; `selectflair` fica como
fallback caso o submit rejeite o flair.

## 11. Agendamento, locking e idempotência

Função SQL `claim_due_posts(p_worker_id text, p_batch int)`:

```sql
update scheduled_posts sp
set status = 'processing', locked_at = now(), locked_by = p_worker_id
from (
  select id from scheduled_posts
  where status = 'scheduled'
    and scheduled_at <= now()
    and (next_attempt_at is null or next_attempt_at <= now())
  order by scheduled_at
  for update skip locked
  limit p_batch
) due
where sp.id = due.id
returning sp.*;
```

`for update skip locked` garante que duas instâncias do worker nunca reivindicam
o mesmo job — publicação duplicada é impossível por construção, não por
convenção. Função equivalente `claim_due_comments`, que só considera comentários
cujo post pai já tem `reddit_post_id`.

Um `reaper` devolve para `scheduled` qualquer job em `processing` com
`locked_at < now() - interval '10 minutes'` (worker morto no meio).

Sequência de publicação: claim atômico → `processing` → revalidar requisitos →
`POST /api/submit` → gravar `reddit_post_id`, `reddit_fullname`, permalink →
`published` + `published_at` → materializar `scheduled_at` dos comentários
dependentes.

### Retentativas

- Erros transitórios (`RateLimited`, `NetworkError`, `RedditUnavailable`,
  `ProxyUnavailable`): `retry_count++`, backoff exponencial
  (1 min, 5 min, 25 min), respeitando `Retry-After` quando presente.
  Após 3 tentativas → `failed`.
- Erros definitivos (`NoPermission`, `SubredditNotFound`, `ContentRejected`,
  `FlairRequired`, `RefreshInvalid`): `failed` imediatamente. Retentar seria
  inútil e abusivo.

### Rate limiting interno

- No máximo uma publicação simultânea por conta Reddit.
- Espaçamento mínimo configurável entre publicações da mesma conta.
- O worker pausa quando `X-Ratelimit-Remaining` cai abaixo de um limiar,
  retomando após `X-Ratelimit-Reset`.

## 12. Comentários programados

No formulário de publicação, um toggle *Adicionar comentário automático* abre:
texto do comentário e quando comentar — imediatamente após a publicação,
X minutos depois, ou horário absoluto. O comentário vira uma linha em
`scheduled_comments`, processada pelo mesmo mecanismo de claim, sempre pela
mesma conta que publicou.

## 13. Páginas

- **Dashboard** — cards Hoje / Publicados / Pendentes / Falhas e lista das
  próximas publicações.
- **Nova publicação** — conta, comunidade (filtrada pela conta), título, link,
  texto, flair, data, horário, timezone, publicar agora ou programar,
  comentário automático opcional.
- **Calendário** — grade mensal/semanal com cards (horário, conta, comunidade,
  título, status); clique abre detalhes; editar/reagendar/cancelar apenas
  enquanto não publicado.
- **Fila** — ordem cronológica com filtros por conta, comunidade, status e período.
- **Histórico** — publicados/falhos/cancelados, com horário planejado vs. real,
  Reddit post ID, permalink e botão *Abrir no Reddit*.
- **Contas Reddit** — conectar via OAuth, status, reconectar, remover,
  configuração de rede opcional por conta.
- **Comunidades** — lista sincronizada por conta, botão *Sincronizar comunidades*.
- **Logs** — `execution_logs` filtráveis, já sanitizados.
- **Configurações** — timezone e retenção de logs (por usuário, graváveis),
  intervalo do worker (global, definido por `WORKER_INTERVAL_SECONDS` no VPS e
  exibido apenas como leitura, junto do horário do último ciclo) e estado da
  integração Reddit (nunca o client secret).

UI desktop-first e responsiva, sidebar fixa no desktop e drawer no mobile,
visual minimalista.

## 14. Logs e sanitização

`sanitize.ts` remove, por lista de chaves e por regex, qualquer ocorrência de
`access_token`, `refresh_token`, `Authorization`, `client_secret`, senha de
proxy e cookies antes de qualquer escrita em `execution_logs` ou `console`.
Um teste dedicado alimenta o sanitizador com um objeto contendo cada segredo e
verifica que nenhum aparece na saída.

## 15. Segurança

- `state` validado por cookie httpOnly no OAuth (PKCE indisponível no Reddit).
- Middleware protegendo todas as rotas do painel.
- Zod validando toda entrada de server action e route handler.
- Secrets exclusivamente server-side; `env.ts` valida e separa públicas de privadas.
- AES-256-GCM para tokens e senha de proxy.
- RLS por `owner_id`; tabelas de segredo sem policy alguma.
- Locking atômico contra publicação duplicada.
- Rate limiting interno por conta.
- Erros nunca vazam detalhes de infraestrutura ao cliente.
- `.env.example` versionado, `.env.local` no `.gitignore`.

## 16. Testes

Vitest, com Supabase local (Docker) para integração.

- OAuth: geração e validação de `state`, rejeição de state divergente/ausente,
  troca de code, upsert de conta.
- Refresh: renovação antes de expirar, lock concorrente, refresh inválido →
  conta desconectada.
- Payload builder: cada linha da tabela da seção 10, incluindo os bloqueios.
- Agendamento: criação, edição, cancelamento, impossibilidade de editar
  publicado.
- Publicação: sucesso, gravação de permalink, cada erro tipado
  (via `undici.MockAgent`).
- Rate limit: 429 com `Retry-After` respeitado, backoff correto.
- Idempotência: dois workers concorrentes contra o mesmo lote — exatamente um
  claim por job (integração real no Postgres).
- Comentários: só publicam com `reddit_post_id`; recálculo de horário.
- Configuração de rede: dispatcher correto quando habilitada/desabilitada.
- Segredos: sanitizador de logs e ausência de tokens em qualquer payload
  retornado ao cliente.

## 17. Fases de implementação

| Fase | Escopo |
|---|---|
| 0 | Scaffold, `env.ts`, lint/typecheck/vitest, projeto Supabase, migrations base, `.env.example` |
| 1 | Supabase Auth, middleware, layout e sidebar |
| 2 | OAuth Reddit, contas, criptografia, config de rede, factory, refresh |
| 3 | Sincronização de comunidades, flairs, post_requirements |
| 4 | Nova publicação, validação, payload builder, comentários programados |
| 5 | Worker: claim, publicação, comentários, retries, rate limit, logs, reaper |
| 6 | Calendário, Fila, Histórico, Logs, Dashboard, Configurações |
| 7 | Suíte de testes completa, README, documentação de limitações |

Cada fase encerra com `lint`, `typecheck` e `test` verdes antes da seguinte.

## 18. Limitações impostas pela API oficial do Reddit

1. **PKCE não é suportado** — proteção via `state` em cookie httpOnly.
2. **Link post não aceita corpo de texto.** Título + link + texto é impossível
   numa única submissão; a alternativa oficial é comentar depois.
3. **Upload nativo de imagem/vídeo está fora de escopo** — exige upload lease e
   confirmação por WebSocket. Suportamos link post apontando para a mídia.
4. **Rate limit de 100 requisições/minuto por `client_id`**, compartilhado entre
   todas as contas conectadas, medido em janela de ~10 minutos.
5. **`post_requirements` não cobre regras de AutoModerator**; algumas rejeições
   só aparecem no momento da submissão.
6. **Listagens paginam até ~1000 itens.**
7. **O Reddit não oferece agendamento nativo via API** — o agendamento é nosso.
8. **Refresh tokens podem ser revogados** pelo usuário a qualquer momento,
   exigindo reconexão manual.
9. **Crossposts, enquetes e galerias** não fazem parte do escopo inicial.
10. **A Reddit Data API é gratuita para uso não comercial** dentro do limite
    acima; uso comercial exige acordo com o Reddit.

## 19. Entregáveis finais

Aplicação funcionando, migrations Supabase, `.env.example`, README com
instruções de configuração do app OAuth do Reddit, do projeto Supabase e da
execução do worker, além da lista de funcionalidades implementadas e desta
lista de limitações.
