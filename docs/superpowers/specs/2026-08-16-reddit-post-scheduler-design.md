# Reddit Post Scheduler — Design

Data: 2026-08-16
Revisão: 2 (correções de idempotência, isolamento multiusuário, OAuth state e rate limit)
Status: aprovado

## 1. Objetivo

Painel privado multi-usuário para agendar e publicar automaticamente no Reddit,
usando exclusivamente a API/OAuth oficial. Cada usuário conecta múltiplas contas
Reddit próprias (que moderam as próprias comunidades), cria publicações, escolhe
conta, comunidade, data e horário, e o sistema publica sozinho no momento
marcado — opcionalmente adicionando um comentário logo em seguida.

### Fora de escopo, por decisão explícita

Nada de browser automation, Selenium, Playwright para postar, login por senha,
manipulação de fingerprint, bypass de CAPTCHA, ban evasion, rotação de proxies,
proxy pool, troca de IP após erro, retry de 403 por outra rota, criação
automática de contas, ocultação de comportamento coordenado ou bypass de rate
limit. Quando o Reddit rejeita uma ação, o sistema registra o erro e para.

## 2. Decisões tomadas

| Decisão | Escolha |
|---|---|
| Worker | Processo Node standalone (Docker no VPS), loop próprio |
| Tenancy | Multi-usuário desde o início, RLS por `owner_id` |
| App OAuth Reddit | Ainda não criado — Fase -1 cobre o acesso à Reddit Data API |
| Supabase | Projeto novo `reddit-scheduler`, região sa-east-1 |
| Deploy web | Vercel |
| Deploy worker | VPS via Docker |
| Testes | Unit + integração (Vitest + Supabase local via Docker), sem E2E |
| Semântica de entrega | **At-most-one concurrent claim**, não exactly-once (ver seção 11) |

## 3. Stack

- Next.js (App Router) + React + TypeScript strict
- Tailwind CSS v4 + primitivas Radix UI + lucide-react
- Supabase: Postgres + Auth (`@supabase/ssr`)
- `undici` para HTTP (necessário para proxy por conta) — ver seção 19
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
                | accounts | communities | logs | settings | review
    api/reddit/authorize/route.ts
    api/reddit/callback/route.ts
    api/health/route.ts
  components/            ui/ (primitivas) + domínio
  lib/
    auth/     require-user.ts ownership.ts   <- helpers centralizados (seção 6)
    reddit/   auth.ts client.ts reddit-client-factory.ts posts.ts
              comments.ts communities.ts flairs.ts requirements.ts
              reconcile.ts errors.ts types.ts ratelimit.ts
    crypto/   aes-gcm.ts
    supabase/ server.ts admin.ts middleware.ts client.ts
    scheduling/ payload-builder.ts validation.ts schedule.ts
    logging/  sanitize.ts execution-log.ts
    config/   env.ts (Zod sobre process.env)
worker/
  index.ts post-runner.ts comment-runner.ts reaper.ts lock.ts
  rate-coordinator.ts consistency.ts
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
zero policies**, e sem `GRANT` algum para `authenticated`/`anon`: nenhum SELECT
do cliente alcança essas linhas, mesmo com a publishable key vazada. Somente
`service_role` acessa — e sempre atrás dos helpers de autorização da seção 6.

| Tabela | Campos principais | Frontend |
|---|---|---|
| `profiles` | `id` (=auth.users.id), `timezone` default `America/Sao_Paulo`, `log_retention_days` | leitura/escrita própria |
| `reddit_accounts` | ver 5.2 | leitura própria |
| `reddit_account_secrets` | `reddit_account_id` PK/FK, `access_token_enc`, `refresh_token_enc`, `access_token_expires_at`, `refresh_lock_at` | **nenhum** |
| `reddit_account_network_configs` | `reddit_account_id` PK/FK, `owner_id`, `proxy_enabled`, `proxy_protocol` (`http`/`https`/`socks5`), `proxy_host`, `proxy_port`, `proxy_username`, `proxy_password_enc` | **nenhum** |
| `oauth_states` | ver 7.1 | **nenhum** |
| `subreddits` | ver 5.4 | leitura própria |
| `scheduled_posts` | ver 5.5 | leitura/escrita própria |
| `scheduled_comments` | ver 5.6 | leitura/escrita própria |
| `reddit_api_budget` | ver 12.3 | leitura própria (somente agregados) |
| `execution_logs` | `id`, `owner_id`, `reddit_account_id`, `scheduled_post_id`, `scheduled_comment_id`, `action`, `http_status`, `outcome` (`success`/`failure`/`retry`/`unknown`), `error_code`, `error_message` (sanitizado), `duration_ms`, `created_at` | leitura própria |

### 5.2 `reddit_accounts` e status de rede

`id`, `owner_id`, `reddit_user_id`, `username`, `scopes text[]`, `status`
(`connected`/`expired`/`disconnected`/`revoked`), `last_authenticated_at`,
`last_error`, `min_interval_seconds` (espaçamento entre publicações da conta,
default 300), `last_submit_at`.

Colunas **derivadas** de rede, mantidas por trigger a partir de
`reddit_account_network_configs` e contendo apenas dados não sensíveis:
`proxy_enabled`, `proxy_protocol`, `proxy_host_masked`, `proxy_port`.

Unique: `(owner_id, reddit_user_id)`. Unique auxiliar `(id, owner_id)` para as
FKs compostas da seção 5.3.

**Por que colunas derivadas:** a view de status precisa de `security_invoker = true`
(exigência de segurança), mas uma view com `security_invoker` sobre uma tabela
com zero policies retornaria zero linhas para o usuário — as policies da tabela
base se aplicam ao invocador. Duplicar apenas os campos não sensíveis em
`reddit_accounts` (que tem policy por `owner_id`) resolve o conflito sem afrouxar
o isolamento: `proxy_host` completo, `proxy_username` e a senha continuam
inalcançáveis pelo cliente.

O mascaramento acontece no trigger, não na leitura: `proxy.exemplo.com` vira
`pr***.exemplo.com`; um IP vira `203.0.113.***`.

```sql
create view reddit_account_network_status
with (security_invoker = true) as
select id as reddit_account_id, proxy_enabled, proxy_protocol,
       proxy_host_masked, proxy_port
from reddit_accounts;
```

A view nunca expõe `proxy_username`, senha (cifrada ou não), string de conexão
completa, token ou qualquer credencial decifrada.

### 5.3 Integridade referencial entre owners

O isolamento não pode depender só do código da aplicação. FKs compostas tornam
impossível, no banco, misturar recursos de owners diferentes:

- `reddit_accounts`: `unique (id, owner_id)`
- `subreddits`: `unique (id, owner_id)`, `unique (id, reddit_account_id)`,
  FK `(reddit_account_id, owner_id) → reddit_accounts(id, owner_id)` on delete cascade
- `scheduled_posts`:
  FK `(reddit_account_id, owner_id) → reddit_accounts(id, owner_id)`,
  FK `(subreddit_id, owner_id) → subreddits(id, owner_id)`,
  FK `(subreddit_id, reddit_account_id) → subreddits(id, reddit_account_id)`
  — esta última garante que o subreddit escolhido pertence à conta escolhida,
  e não apenas ao mesmo usuário;
  `unique (id, owner_id)`, `unique (id, reddit_account_id)`
- `scheduled_comments`:
  FK `(scheduled_post_id, owner_id) → scheduled_posts(id, owner_id)`,
  FK `(scheduled_post_id, reddit_account_id) → scheduled_posts(id, reddit_account_id)`
  — o comentário é sempre publicado pela mesma conta que publicou o post
- `reddit_account_network_configs` e `reddit_account_secrets`:
  FK `(reddit_account_id, owner_id) → reddit_accounts(id, owner_id)` on delete cascade

Com isso, um INSERT malicioso combinando UUIDs de owners diferentes falha por
violação de FK mesmo se toda a camada de aplicação for contornada.

### 5.4 `subreddits`

`id`, `owner_id`, `reddit_account_id`, `subreddit_fullname` (t5_…), `name`,
`display_name`, `url`, `over_18`, `status`, `last_synced_at`.
Unique `(reddit_account_id, subreddit_fullname)`.

### 5.5 `scheduled_posts`

`id`, `owner_id`, `reddit_account_id`, `subreddit_id`, `title`, `url`, `body`,
`flair_id`, `flair_text`, `post_kind` (`link`/`self`), `nsfw`, `spoiler`,
`scheduled_at timestamptz`, `timezone`, `status`, `reddit_post_id`,
`reddit_fullname`, `reddit_permalink`, `error_code`, `error_message`,
`retry_count`, `next_attempt_at`, `locked_at`, `locked_by`,
**`submit_attempted_at`**, **`review_reason`**, **`resolved_by`**,
**`resolved_at`**, `published_at`, `created_at`, `updated_at`.

`submit_attempted_at` é gravado e commitado **imediatamente antes** de escrever a
requisição de submissão. É o que distingue "nunca saiu" de "pode ter chegado" —
ver seção 11.

Índices: `(status, scheduled_at)` parcial para `status='scheduled'`;
`(owner_id, scheduled_at desc)`; `(reddit_account_id, status)`;
`(owner_id, status)` parcial para `status='needs_review'`.
Unique parcial em `(reddit_account_id, reddit_post_id)` where `reddit_post_id` not null.

### 5.6 `scheduled_comments`

`id`, `owner_id`, `scheduled_post_id`, `reddit_account_id`, `body`,
`mode` (`immediate` / `delay` / `absolute`), `delay_minutes`, `scheduled_at`,
`status`, `reddit_comment_id`, `reddit_permalink`, `error_code`, `error_message`,
`retry_count`, `next_attempt_at`, `locked_at`, `locked_by`,
`submit_attempted_at`, `review_reason`, `resolved_by`, `resolved_at`,
`published_at`.

Regra invariante: só é elegível quando o post pai tem `reddit_post_id` não nulo
e status `published`. Em modo `immediate`/`delay`, `scheduled_at` do comentário é
recalculado a partir do `published_at` real do post. Se o post pai termina em
`failed`, `cancelled` ou `needs_review`, o comentário vai para `cancelled` com
motivo — nunca é publicado "solto".

### 5.7 Máquina de estados

Idêntica para posts e comentários:

```
draft ──> scheduled ──> processing ──> published
  │           │             ├────────> failed
  │           │             └────────> needs_review   (resultado desconhecido)
  └───────────┴──────────────────────> cancelled

needs_review ──(resolução manual)──> published | failed | cancelled
```

Transições proibidas, garantidas por CHECK constraint e trigger:

- `needs_review → scheduled` **nunca acontece automaticamente**. O reaper não
  pode tocar nesse estado.
- `published` é terminal; só admite edição do permalink numa resolução manual.
- `processing → scheduled` só é permitido pelo reaper quando
  `submit_attempted_at is null`.

`needs_review` significa: *o worker não sabe se o Reddit criou a publicação*.
Exige decisão humana.

### 5.8 Timezone

`scheduled_at` é sempre `timestamptz` (UTC no banco). A coluna `timezone` guarda
o fuso escolhido apenas para exibir e reeditar corretamente. Conversão acontece
na borda, com `@date-fns/tz`.

## 6. Autenticação e autorização

### 6.1 Painel

Supabase Auth (email + senha). `middleware.ts` refresca a sessão e protege
`/dashboard/*`, redirecionando para `/login`. Trigger `on auth.users insert`
cria a linha em `profiles` com o timezone padrão.

### 6.2 Autorização antes de qualquer uso do `service_role`

O `service_role` ignora RLS. Portanto, **nunca** aceitar um `reddit_account_id`
vindo do cliente e consultar secrets diretamente com o client administrativo.
A ordem obrigatória em toda server action e route handler é:

1. `requireUser()` — obtém o usuário autenticado da sessão; lança se ausente;
2. consultar `reddit_accounts` **com o client do usuário** (RLS ativa);
3. confirmar `reddit_accounts.owner_id === user.id`;
4. só então acessar secrets/config com o client administrativo.

Isso vive em `src/lib/auth/ownership.ts`, centralizado, e é reforçado por tipos:

```ts
type VerifiedAccount = RedditAccount & { readonly __verified: unique symbol }

async function assertAccountAccess(accountId: string): Promise<VerifiedAccount>
async function assertSubredditAccess(subredditId: string, account: VerifiedAccount)
async function getAccountSecrets(account: VerifiedAccount)   // nunca aceita string
async function getNetworkConfig(account: VerifiedAccount)    // nunca aceita string
```

`getAccountSecrets` e `getNetworkConfig` **não aceitam UUID**, apenas o objeto
`VerifiedAccount` que só `assertAccountAccess` sabe produzir. Um IDOR por troca
de UUID deixa de compilar, em vez de depender de alguém lembrar da checagem.

### 6.3 Consistência no worker

O worker recebe jobs do próprio banco, não de entrada do usuário, mas ainda
valida antes de publicar (`worker/consistency.ts`):

`scheduled_posts.owner_id === reddit_accounts.owner_id === subreddits.owner_id`,
e `subreddits.reddit_account_id === scheduled_posts.reddit_account_id`.

Divergência → job vai para `failed` com código `INCONSISTENT_OWNERSHIP`, log em
nível crítico, e nenhuma requisição é enviada ao Reddit. Na prática as FKs
compostas da seção 5.3 tornam isso inalcançável; a checagem é defesa em
profundidade contra migration futura mal feita.

## 7. OAuth Reddit

Fluxo *authorization code* com app confidencial (tipo **web app**).

**PKCE não é documentado nem suportado no fluxo atual da Reddit Data API
utilizado por esta aplicação.** A proteção disponível e implementada é o
parâmetro `state`, tratado com o rigor descrito abaixo.

### 7.1 `state`

Tabela `oauth_states`: `id`, `owner_id`, `state_hash` (SHA-256 do valor),
`created_at`, `expires_at`, `consumed_at`, `redirect_to`. RLS habilitada, zero
policies — só `service_role`.

Propriedades exigidas:

- entropia criptograficamente segura: 32 bytes de `crypto.randomBytes`, base64url;
- **uso único**: consumido por `update ... set consumed_at = now() where
  state_hash = $1 and consumed_at is null returning *`. O update condicional é a
  própria trava contra replay — o segundo callback não encontra linha;
- expira em 10 minutos (`expires_at`), validado além do `consumed_at`;
- **vinculado ao usuário Supabase** que iniciou o fluxo (`owner_id`);
- cookie `httpOnly`, `SameSite=Lax`, `Secure` em produção, `Path=/api/reddit`,
  `Max-Age` de 600 s;
- apenas o hash é persistido; o valor cru existe só no cookie.

### 7.2 Fluxo

1. `GET /api/reddit/authorize` — exige sessão; gera o state, grava o hash com o
   `owner_id`, seta o cookie e redireciona para
   `https://www.reddit.com/api/v1/authorize` com `client_id`, `response_type=code`,
   `state`, `redirect_uri`, `duration=permanent`, `scope`.
2. `GET /api/reddit/callback` valida, nesta ordem:
   - sessão existe (senão rejeita);
   - cookie presente **e** igual ao `state` da query string;
   - linha em `oauth_states` existe, não expirada, consumida atomicamente agora;
   - `oauth_states.owner_id === user.id` — um state de outra sessão é rejeitado;
   - o cookie é apagado independentemente do desfecho.

   Só então troca o `code` em `https://www.reddit.com/api/v1/access_token` com
   HTTP Basic (`client_id:client_secret`), busca `/api/v1/me`, cifra e persiste
   os tokens e faz upsert em `reddit_accounts`.

Erro do Reddit no callback (`error=access_denied`) é tratado como recusa normal,
com mensagem humana, sem criar conta.

Escopos: `identity mysubreddits submit read flair edit history`.
Chamadas de API sempre em `https://oauth.reddit.com`, com
`Authorization: bearer <token>` e `User-Agent` no formato
`web:<app-id>:<versão> (by /u/<seu-usuário>)`.

### 7.3 Refresh

`RedditClientFactory` renova quando faltam menos de 120 s para expirar, usando
`grant_type=refresh_token`. Um lock por conta (`refresh_lock_at`) evita dois
refreshes simultâneos. Refresh token inválido → conta vira `disconnected`, jobs
pendentes daquela conta falham com mensagem pedindo reconexão.

## 8. `RedditClientFactory` e configuração de rede

`getRedditClient(account: VerifiedAccount)`:

1. carrega e decifra `reddit_account_secrets`;
2. renova o access token se necessário e persiste;
3. carrega `reddit_account_network_configs`; se `proxy_enabled`, monta um
   `ProxyAgent` com aquelas credenciais; senão usa o dispatcher global;
4. devolve um cliente que injeta `Authorization` e `User-Agent`, consulta o
   coordenador de rate limit (12.3), lê `X-Ratelimit-*`, respeita `Retry-After`
   e converte respostas em erros tipados.

### 8.1 Proxy — conceito fixo

A configuração de rede é **propriedade da conta Reddit**, não da publicação:

> uma conta pode ter uma configuração de proxy própria, e todas as requisições
> dessa conta passam por ela enquanto estiver habilitada.

Não existe proxy por publicação, proxy pool, rotação, troca de IP após erro,
nem retry de 403 por outra rota. Proxy indisponível é tratado como
indisponibilidade transitória comum: erro registrado e política normal de retry
da seção 11 — jamais como gatilho para mudar de rota.

Credenciais de proxy nunca saem do backend, nunca entram em log e nunca chegam
ao navegador. A URL do proxy é montada em memória; a serialização usada em logs
é sempre a forma mascarada (`socks5://***@pr***.exemplo.com:1080`).

### 8.2 Classificação de erros (`errors.ts`)

Cada erro carrega `code`, mensagem em português e uma **disposição**:

| Disposição | Significado | Ação |
|---|---|---|
| `retryable` | o Reddit comprovadamente **não** processou o pedido | retry com backoff |
| `unknown` | o pedido pode ter sido recebido e processado | `needs_review`, sem retry |
| `terminal` | rejeição definitiva | `failed` |

A disposição depende de **dois** fatores: o erro em si e se a requisição tem
efeito colateral. Requisições de leitura (`post_requirements`, flairs,
listagens, reconciliação) são idempotentes e podem ser repetidas com segurança.
Requisições de efeito (`/api/submit`, `/api/comment`, `selectflair`) não podem.

**Requisições de efeito, após `submit_attempted_at` gravado:**

| Erro | Disposição |
|---|---|
| DNS (`ENOTFOUND`, `EAI_AGAIN`), `ECONNREFUSED`, falha de handshake TLS, `UND_ERR_CONNECT_TIMEOUT`, proxy recusando conexão — falhas comprovadamente **anteriores** ao envio, com `submit_attempted_at` ainda nulo | `retryable` |
| `429` | `retryable`, seguindo `Retry-After` e o coordenador de rate limit — um 429 é uma recusa explícita de processar |
| `ECONNRESET` / socket hang up **após** o envio, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, abort pós-envio, resposta ilegível | `unknown` |
| **`500`, `502`, `503`, `504`** | `unknown` |
| `403` sem permissão, `404` subreddit inexistente, `200` com `json.errors` não vazio (conteúdo rejeitado, flair obrigatório, domínio bloqueado), refresh token inválido | `terminal` |

**Por que `503` também é `unknown`:** não existe documentação oficial do Reddit
garantindo que um `POST /api/submit` respondido com 5xx não produziu efeito. Um
gateway pode falhar depois que o upstream processou a submissão. Na ausência
dessa garantia explícita, todo 5xx sobre uma requisição de efeito é tratado como
ambíguo. Se a documentação oficial passar a garantir o contrário para algum
status específico, a reclassificação é uma linha nesta tabela.

**Requisições de leitura:** `429`, `500`, `502`, `503`, `504` e erros de rede são
todos `retryable`, com backoff. Não há ambiguidade porque não há efeito a
duplicar.

`NetworkError` **não é retryable por padrão** — a disposição depende de onde a
falha ocorreu em relação ao envio e de a requisição ter efeito ou não.

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
| Reconciliação assistida (10.2) | `GET /user/{username}/submitted?limit=25` | history |

## 10. Construção do payload de publicação

`post_requirements` é consultado no agendamento (para validar o formulário) e
novamente imediatamente antes de publicar. Campos relevantes:
`title_text_min_length`, `title_text_max_length`, `body_restriction_policy`
(`required` | `notAllowed` | `none`), `is_flair_required`, `domain_whitelist`,
`domain_blacklist`, `title_blacklisted_strings`, `body_blacklisted_strings`.

| Entrada do usuário | `kind` enviado | Comportamento |
|---|---|---|
| Título + link | `link` com `url` | direto |
| Título + texto | `self` com `text` | direto |
| Título + link + texto | `link` com `url` | A API do Reddit não aceita corpo junto de um link post. A UI deixa isso claro **antes do agendamento** e oferece enviar o texto como comentário automático (seção 13), via endpoint oficial. |
| Link em sub com `body_restriction_policy = required` | — | bloqueado no formulário, com o motivo |
| Texto em sub com `body_restriction_policy = notAllowed` | — | bloqueado no formulário |
| Sub com `is_flair_required` | — | flair torna-se obrigatório |

Flair vai em `flair_id` no próprio `/api/submit`; `selectflair` é fallback caso o
submit rejeite o flair.

### 10.2 Reconciliação assistida

Para jobs em `needs_review`, o dashboard oferece **Verificar no Reddit**: uma
leitura de `GET /user/{username}/submitted` que lista candidatos compatíveis
(mesmo subreddit, título idêntico, dentro da janela de tempo do job). O usuário
confirma o vínculo — o job vira `published` com o permalink real — ou declara que
não foi publicado — o job vira `failed` e pode ser reagendado manualmente.

A reconciliação **é sempre uma leitura**. Nunca reenvia, nunca decide sozinha,
nunca é disparada automaticamente pelo reaper.

## 11. Agendamento, locking e garantias reais

### 11.1 O que `FOR UPDATE SKIP LOCKED` garante

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

Isto garante **at-most-one concurrent claim**: duas instâncias do worker nunca
processam o mesmo job ao mesmo tempo. Função equivalente `claim_due_comments`,
que só considera comentários cujo post pai já tem `reddit_post_id`.

### 11.2 O que ele *não* garante

Não é entrega *exactly-once*. Existe uma janela real de incerteza:

1. worker faz claim do post;
2. envia `POST /api/submit`;
3. o Reddit cria a publicação;
4. o worker perde a conexão ou morre antes de persistir `reddit_post_id`;
5. o job fica órfão em `processing`;
6. um retry cego criaria uma **segunda** publicação.

Nenhum locking de banco fecha essa janela, porque ela está entre dois sistemas
distintos. O que o sistema faz é **detectá-la e recusar-se a adivinhar**.

### 11.3 Como a janela é tratada

`submit_attempted_at` é gravado e commitado imediatamente antes de escrever a
requisição. Ele divide o `processing` em duas fases com desfechos diferentes:

| Situação | `submit_attempted_at` | Desfecho |
|---|---|---|
| Falha antes do envio (DNS, conexão recusada, proxy fora, token inválido) | `null` | volta para `scheduled`, retry seguro |
| Resposta recebida e interpretada | preenchido | `published` ou `failed`, conforme o corpo |
| Erro de disposição `unknown` (seção 8.2) | preenchido | `needs_review`, **sem retry** |
| Worker morreu no meio, reaper encontra o órfão | `null` | volta para `scheduled` |
| Worker morreu no meio, reaper encontra o órfão | preenchido | `needs_review`, **sem retry** |

O reaper roda a cada ciclo sobre jobs com `locked_at < now() - 10 min` e aplica
exatamente a tabela acima. **O reaper nunca transforma um estado ambíguo em nova
submissão** — não existe caminho automático de `needs_review` para `scheduled`.

Jobs em `needs_review` aparecem em destaque no Dashboard e numa página própria
(`/dashboard/review`), com o motivo, o horário da tentativa e o botão de
reconciliação assistida da seção 10.2.

### 11.4 Retentativas

- Disposição `retryable`: `retry_count++`, backoff exponencial (1 min, 5 min,
  25 min), respeitando `Retry-After` quando presente. Após 3 tentativas → `failed`.
- Disposição `terminal`: `failed` imediatamente. Retentar seria inútil e abusivo.
- Disposição `unknown`: **nunca** retry. Vai direto para `needs_review`.

## 12. Rate limiting

### 12.1 Postura

O limite documentado (na ordem de 100 requisições/minuto por `client_id`) vale
conforme as condições de acesso vigentes da Reddit Data API para a aplicação, e
não é uma garantia universal. A **fonte operacional de verdade são os headers
retornados pela própria API**: `X-Ratelimit-Used`, `X-Ratelimit-Remaining`,
`X-Ratelimit-Reset`, além de `Retry-After` em 429.

O sistema obedece a esses headers. Não existe nenhum mecanismo para contornar
rate limit — nem por proxy, nem por conta diferente, nem por múltiplos
`client_id`. Atingir o limite significa esperar.

### 12.2 Controles por conta

- no máximo uma publicação simultânea por conta Reddit;
- espaçamento mínimo configurável entre publicações da mesma conta
  (`reddit_accounts.min_interval_seconds`, verificado contra `last_submit_at`).

### 12.3 Coordenador global por `client_id`

Controle por conta não basta: o limite do Reddit é por aplicação. Tabela
`reddit_api_budget`, uma linha por `client_id`:
`client_id_hash`, `used`, `remaining`, `reset_at`, `updated_at`, `paused_until`.

- Toda resposta da API atualiza a linha a partir dos headers.
- Antes de cada requisição, o worker consulta o orçamento (cache em memória de
  5 s para não martelar o banco).
- Se `remaining` cai abaixo do limiar, o worker define `paused_until = reset_at`
  e **todas as instâncias** param de emitir requisições até lá.
- Um 429 com `Retry-After` propaga a pausa globalmente da mesma forma.

Isso mantém a coordenação correta mesmo com múltiplas réplicas do worker.

## 13. Comentários programados

No formulário, um toggle *Adicionar comentário automático* abre: texto e quando
comentar — imediatamente após a publicação, X minutos depois, ou horário
absoluto. Vira uma linha em `scheduled_comments`, processada pelo mesmo mecanismo
de claim, sempre pela mesma conta que publicou (garantido por FK composta).

A janela de incerteza da seção 11.2 vale igualmente para `POST /api/comment`:
comentário com desfecho desconhecido vai para `needs_review`, nunca é reenviado.

## 14. Páginas

- **Dashboard** — cards Hoje / Publicados / Pendentes / Falhas, alerta destacado
  de itens em `needs_review`, e lista das próximas publicações.
- **Nova publicação** — conta, comunidade (filtrada pela conta), título, link,
  texto, flair, data, horário, timezone, publicar agora ou programar, comentário
  automático opcional, com o aviso de link+texto explícito antes do agendamento.
- **Calendário** — grade mensal/semanal com cards; clique abre detalhes;
  editar/reagendar/cancelar apenas enquanto não publicado.
- **Fila** — ordem cronológica com filtros por conta, comunidade, status e período.
- **Revisão** (`/dashboard/review`) — itens em `needs_review`, com motivo,
  horário da tentativa, reconciliação assistida e resolução manual.
- **Histórico** — publicados/falhos/cancelados, horário planejado vs. real,
  Reddit post ID, permalink e botão *Abrir no Reddit*.
- **Contas Reddit** — conectar via OAuth, status, reconectar, remover,
  configuração de rede opcional por conta (host sempre mascarado na leitura).
- **Comunidades** — lista sincronizada por conta, botão *Sincronizar comunidades*.
- **Logs** — `execution_logs` filtráveis, já sanitizados.
- **Configurações** — timezone e retenção de logs (por usuário, graváveis),
  intervalo do worker (global, definido por `WORKER_INTERVAL_SECONDS` no VPS,
  exibido apenas como leitura junto do último ciclo) e estado da integração
  Reddit (nunca o client secret).

UI desktop-first e responsiva, sidebar fixa no desktop e drawer no mobile,
visual minimalista.

## 15. Logs e sanitização

`sanitize.ts` remove, por lista de chaves e por regex, qualquer ocorrência de
`access_token`, `refresh_token`, `Authorization`, `client_secret`, senha de
proxy, URL de proxy com credenciais embutidas e cookies, antes de qualquer
escrita em `execution_logs` ou `console`. A regex cobre também a forma
`protocolo://usuario:senha@host`.

## 16. Segurança

- `state` de uso único, com entropia forte, expiração curta, vinculado ao usuário
  e validado contra replay (PKCE indisponível no fluxo atual da Reddit Data API).
- Middleware protegendo todas as rotas do painel.
- Zod validando toda entrada de server action e route handler.
- Autorização centralizada e tipada antes de qualquer uso do `service_role` (6.2).
- FKs compostas impedindo mistura de owners no próprio banco (5.3).
- Secrets exclusivamente server-side; `env.ts` valida e separa públicas de privadas.
- AES-256-GCM para tokens e senha de proxy.
- RLS por `owner_id`; tabelas de segredo sem policy e sem grant.
- View de status de rede com `security_invoker = true`.
- Claim atômico contra processamento concorrente; estados ambíguos exigem revisão
  humana em vez de retry.
- Rate limiting por conta e global por `client_id`.
- Erros nunca vazam detalhes de infraestrutura ao cliente.
- `.env.example` versionado, `.env.local` no `.gitignore`.

## 17. Testes

Vitest, com Supabase local (Docker) para integração.

### 17.1 OAuth
state válido; state ausente; state divergente do cookie; state expirado;
**state usado duas vezes (replay)**; state pertencente a outra sessão; callback
sem sessão; `access_denied`; troca de code; upsert de conta.

### 17.2 Refresh
renovação antes de expirar; lock concorrente; refresh inválido → conta
desconectada e jobs pendentes falhando com mensagem humana.

### 17.3 Segurança multiusuário (dois usuários, A e B)
A não lê nem altera contas de B; A não lê secrets da conta de B; A não altera a
configuração de proxy de B; A não cria agendamento com `reddit_account_id` de B;
A não mistura `subreddit_id` pertencente a outra conta/owner; A não vê o status
de rede das contas de B pela view; nenhuma server action administrativa permite
IDOR trocando apenas UUIDs.

### 17.4 Payload builder
cada linha da tabela da seção 10, incluindo os bloqueios por
`body_restriction_policy` e `is_flair_required`.

### 17.5 Agendamento
criação, edição, cancelamento; impossibilidade de editar publicado; recálculo de
horário de comentários.

### 17.6 Worker e janela de falha
- dois workers tentando claim simultâneo — exatamente um claim por job;
- crash **antes** do submit (`submit_attempted_at is null`) → volta para
  `scheduled` e retry é seguro;
- crash **depois** de resposta confirmada → estado final correto, sem duplicar;
- conexão perdida **depois** que o request pode ter sido enviado → `needs_review`;
- job em `needs_review` nunca sofre retry automático, em nenhum ciclo;
- reaper não transforma estado ambíguo em nova submissão;
- reaper devolve corretamente apenas órfãos com `submit_attempted_at is null`;
- cada erro tipado da seção 8.2 mapeia para a disposição correta
  (via `undici.MockAgent`);
- `500`, `502`, `503` e `504` em `/api/submit` e `/api/comment` → `needs_review`,
  sem retry, inclusive o `503`;
- os mesmos status em requisições de leitura → retry normal com backoff;
- 429 com `Retry-After` respeitado; backoff exponencial correto;
- coordenador global pausa todas as instâncias ao esgotar o orçamento;
- espaçamento mínimo por conta respeitado.

### 17.7 Configuração de rede
dispatcher correto quando habilitada e quando desabilitada; proxy indisponível
gera erro registrado e política normal de retry, sem troca de rota; verificação
empírica de `http`, `https` e `socks5` contra a versão instalada do undici (19.2).

### 17.8 Secrets e logs
nenhum access token, refresh token, client secret, senha de proxy, header
`Authorization` ou URL de proxy com credenciais aparece em `execution_logs`, em
`console` ou em qualquer payload retornado ao cliente. O teste alimenta o
sanitizador com um objeto contendo cada segredo e verifica a ausência de todos.

## 18. Fases de implementação

| Fase | Escopo |
|---|---|
| **-1** | **Acesso oficial à Reddit Data API** (ver 18.1) — sem código |
| 0 | Scaffold, `env.ts`, lint/typecheck/vitest, projeto Supabase, migrations base, `.env.example`, Dependabot |
| 1 | Supabase Auth, middleware, layout e sidebar |
| 2 | OAuth Reddit (state endurecido), contas, criptografia, config de rede, factory, refresh, verificação empírica do undici |
| 3 | Sincronização de comunidades, flairs, post_requirements |
| 4 | Nova publicação, validação, payload builder, comentários programados |
| 5 | Worker: claim, `submit_attempted_at`, publicação, comentários, reaper, `needs_review`, retries por disposição, coordenador de rate limit, logs |
| 6 | Calendário, Fila, Revisão, Histórico, Logs, Dashboard, Configurações |
| 7 | Suíte de testes completa, README, documentação de limitações |

Cada fase encerra com `lint`, `typecheck`, `test` e `npm audit` verdes antes da
seguinte.

### 18.1 Fase -1 — acesso à Reddit API

Etapa de pré-requisito, executada por você, documentada no README:

1. possuir acesso permitido à Reddit Data API, sob os termos vigentes do Reddit
   para o tipo de uso pretendido;
2. criar e configurar o app OAuth conforme as regras atuais do Reddit,
   escolhendo o tipo **web app**;
3. obter o `client_id`;
4. obter o `client_secret`;
5. configurar o redirect URI de desenvolvimento
   (`http://localhost:3000/api/reddit/callback`);
6. configurar o redirect URI de produção
   (`https://<dominio>/api/reddit/callback`);
7. preencher as variáveis correspondentes no ambiente.

O README deixa explícito que **criar uma entrada em `/prefs/apps` não implica
acesso irrestrito**: o nível de acesso, os limites e a elegibilidade de uso são
determinados pelo Reddit sob os termos da Data API, podem exigir aprovação
conforme o caso de uso, e podem mudar. A aplicação usa exclusivamente API/OAuth
oficial e respeita esses termos e limites. Nenhum mecanismo de bypass será
adicionado em nenhuma hipótese.

## 19. Dependências e supply chain

### 19.1 Política

- `undici` em versão atual e corrigida (piso `^8.10.0`, publicada em 2026-08-03);
  nunca fixar versão antiga vulnerável;
- `package-lock.json` versionado;
- atualização automatizada via **Dependabot** (`.github/dependabot.yml`, semanal,
  cobrindo `npm` e `github-actions`);
- `npm audit --audit-level=high` no script `verify` e no CI. Fica documentado que
  `npm audit` cobre apenas vulnerabilidades já publicadas em advisory e **não
  garante** ausência de vulnerabilidades — é um piso, não uma prova.

### 19.2 Verificação empírica do proxy (Fase 2)

A documentação atual do `ProxyAgent` indica suporte a `http`, `https` e `socks5`
(este último delegado internamente a `Socks5ProxyAgent`). Isso **não será
assumido**: a Fase 2 inclui um teste de integração que sobe um proxy HTTP local
e um SOCKS5 local e confirma o roteamento real com a versão instalada. Se algum
protocolo não funcionar na versão em uso, a opção correspondente é desabilitada
na UI com aviso explícito, em vez de oferecer suporte inexistente.

Detalhe de implementação já identificado: o Node 24 traz sua própria linha
*bundled* do Undici por trás do `fetch` global, cuja versão exata varia conforme
o release do Node e deve ser lida em tempo de execução via
`process.versions.undici` — não deve ser fixada nesta documentação. Essa
instância bundled é distinta da dependência `undici` instalada no projeto, e um
dispatcher criado por uma não é compatível com o `fetch` da outra.

Regra para este projeto: `fetch` e `ProxyAgent` são sempre importados **da mesma
dependência `undici` instalada**, em versão atual e corrigida
(`import { fetch, ProxyAgent } from 'undici'`), nunca misturando com o `fetch`
global do Node. O script de diagnóstico do worker registra
`process.versions.undici` e a versão do pacote instalado no startup, para que
qualquer divergência apareça no log em vez de virar bug silencioso.

## 20. Limitações impostas pela API oficial do Reddit

1. **PKCE não é documentado nem suportado no fluxo atual da Reddit Data API**
   utilizado por esta aplicação — proteção via `state` de uso único, vinculado à
   sessão e resistente a replay.
2. **Link post não aceita corpo de texto.** Título + link + texto é impossível
   numa única submissão; a alternativa oficial é comentar depois.
3. **Não há confirmação idempotente de submissão.** A API não oferece chave de
   idempotência nem consulta de "esta submissão foi criada?". Por isso o sistema
   entrega *at-most-one concurrent claim* e encaminha desfechos desconhecidos
   para revisão humana, em vez de prometer exactly-once.
4. **Upload nativo de imagem/vídeo está fora de escopo** — exige upload lease e
   confirmação por WebSocket. Suportamos link post apontando para a mídia.
5. **Rate limit por `client_id`** conforme as condições de acesso vigentes
   (ordem de 100 req/min), medido em janela de ~10 minutos, compartilhado entre
   todas as contas conectadas. Os headers `X-Ratelimit-*` são a fonte de verdade.
6. **`post_requirements` não cobre regras de AutoModerator**; algumas rejeições
   só aparecem no momento da submissão.
7. **Listagens paginam até ~1000 itens.**
8. **O Reddit não oferece agendamento nativo via API** — o agendamento é nosso.
9. **Refresh tokens podem ser revogados** a qualquer momento, exigindo reconexão.
10. **Crossposts, enquetes e galerias** não fazem parte do escopo inicial.
11. **A Reddit Data API é gratuita para uso não comercial** dentro dos limites
    vigentes; uso comercial exige acordo com o Reddit.

## 21. Entregáveis finais

Aplicação funcionando, migrations Supabase, `.env.example`, README com
instruções da Fase -1 (acesso e app OAuth do Reddit), do projeto Supabase e da
execução do worker, além da lista de funcionalidades implementadas e desta lista
de limitações.
