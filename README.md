# Reddit Post Scheduler

Painel privado para agendar e publicar automaticamente no Reddit, usando
exclusivamente a API e o OAuth oficiais.

- Design: [`docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md`](docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md)
- Plano em execução: [`docs/superpowers/plans/2026-08-16-plano-1-fundacao-e-auth.md`](docs/superpowers/plans/2026-08-16-plano-1-fundacao-e-auth.md)

## Fase -1: acesso à Reddit Data API

Antes de qualquer configuração da aplicação:

1. Garanta que você possui acesso permitido à Reddit Data API, sob os termos
   vigentes do Reddit para o seu tipo de uso.
2. Crie e configure o app OAuth conforme as regras atuais do Reddit,
   escolhendo o tipo **web app**.
3. Obtenha o `client_id`.
4. Obtenha o `client_secret`.
5. Configure o redirect URI de desenvolvimento:
   `http://localhost:3000/api/reddit/callback`
6. Configure o redirect URI de produção:
   `https://<seu-dominio>/api/reddit/callback`
7. Preencha `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_REDIRECT_URI` e
   `REDDIT_USER_AGENT` no `.env.local`.

> **Importante:** criar uma entrada em `/prefs/apps` **não** implica acesso
> irrestrito. O nível de acesso, os limites de uso e a elegibilidade são
> determinados pelo Reddit sob os termos da Data API, podem exigir aprovação
> conforme o caso de uso e podem mudar. Esta aplicação usa exclusivamente
> API/OAuth oficiais e respeita esses termos e limites. Nenhum mecanismo de
> bypass de rate limit, bloqueio, CAPTCHA ou ban será adicionado.

O `REDDIT_USER_AGENT` é obrigatório pela API e segue o formato
`web:reddit-scheduler:0.1.0 (by /u/SEU_USUARIO)`.

## Configurar o Supabase

Requer Docker Desktop em execução.

```bash
npx supabase init      # apenas na primeira vez
npx supabase start
npx supabase status    # copie as chaves para o .env.local
npx supabase db reset  # aplica todas as migrations
```

`npx supabase status` imprime a URL da API, a publishable key e a secret key.
A secret key **nunca** deve receber prefixo `NEXT_PUBLIC_`.

Ao escrever o `.env.local` no Windows, garanta que o arquivo fique **sem BOM** —
o `Set-Content -Encoding utf8` do PowerShell 5.1 adiciona BOM e corrompe a
primeira variável do arquivo.

## Rodar

```bash
cp .env.example .env.local   # e preencha os valores
npm install
npm run dev
```

Gere a chave de criptografia com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Rodar o worker

O worker é um processo separado do painel: ele reivindica publicações vencidas,
publica no Reddit e devolve o resultado. Sem ele nada é publicado.

Localmente, com o Supabase no ar e o `.env.local` preenchido:

```bash
npm run worker:local
```

**`npm run worker` recusa bancos de desenvolvimento de propósito.** O stack
local é o mesmo que a suíte de testes usa: um worker apontado para ele
reivindica os jobs dos testes e produz falhas intermitentes difíceis de
rastrear — foi o que aconteceu aqui, com contêineres de verificação que
continuaram rodando sem que ninguém percebesse.

Rodar contra o banco local continua permitido; só precisa ser deliberado. A
flag `--allow-local-db` fica visível a cada execução, e a variável
`WORKER_ALLOW_LOCAL_DB=1` existe para o contêiner, que não recebe argumentos
com a mesma facilidade. São reconhecidos como desenvolvimento os hosts em
loopback, em faixa privada de IP, com sufixo `.local`/`.internal`, e os nomes
que o Docker usa para alcançar a máquina (`host.docker.internal`).

Em produção, com Docker:

```bash
cp .env.example .env.worker    # e preencha; WORKER_ID único por máquina
docker compose up -d --build
docker compose logs -f worker
```

O que ele faz a cada ciclo, nesta ordem:

1. **reaper** — devolve à fila o que uma instância anterior deixou preso;
2. **orçamento** — se o limite do Reddit estourou, o ciclo termina aqui, **sem
   reivindicar nada**;
3. **publicações**, uma por vez;
4. **comentários**, uma por vez;
5. limpeza dos logs vencidos, uma vez por hora.

A ordem entre 2 e 3 não é detalhe de implementação. Um worker jamais pode
esperar orçamento segurando um job em `processing`: passado o timeout, o reaper
de outra instância o recuperaria e dois workers publicariam o mesmo conteúdo.
Verificar antes elimina a situação em vez de administrá-la. Para o caso
irredutível — um único job que demora mais que o timeout — existe o heartbeat,
que renova o lock enquanto o job está vivo.

**Várias instâncias podem rodar ao mesmo tempo**, desde que cada uma tenha seu
`WORKER_ID`. O claim usa `FOR UPDATE SKIP LOCKED`, então duas instâncias nunca
processam o mesmo job simultaneamente. Duas instâncias com o mesmo `WORKER_ID`
conseguiriam renovar o lock uma da outra — daí a exigência.

`SIGTERM` inicia o desligamento gracioso: o worker para de pegar jobs novos e
deixa o atual terminar. O `stop_grace_period` do compose dá margem para isso.

### O que acontece quando algo dá errado

| Situação | Desfecho |
|---|---|
| Reddit recusou (403, conteúdo rejeitado) | `failed`, sem retentar |
| 429 ou rede antes do envio | volta à fila com backoff de 1/5/25 min |
| 5xx ou conexão caída **depois** do envio | `needs_review`, **nunca** retentado |
| Worker morreu antes de enviar | reaper devolve à fila |
| Worker morreu depois de enviar | `needs_review` |

A distinção entre as duas últimas linhas é o campo `submit_attempted_at`,
gravado e commitado imediatamente antes da requisição de submissão. Um
resultado desconhecido nunca vira nova tentativa automática: publicar duas
vezes é pior que esperar uma decisão humana.

## Verificação

```bash
npm run verify   # lint + typecheck + testes + npm audit
```

Os testes de integração exigem o stack local do Supabase no ar
(`npx supabase start`). Para rodar apenas os testes que não tocam no banco:

```bash
npm test -- --project unit
```

A suíte é dividida em dois projetos do Vitest. `unit` roda em paralelo; `db`
roda **um arquivo por vez**, porque todos compartilham o mesmo Postgres, a
fila do worker é global por natureza e alguns testes executam DDL que tranca
a tabela inteira.

`npm audit` cobre apenas vulnerabilidades já publicadas em advisory. É um piso
de segurança, não prova de ausência de vulnerabilidades.

## Decisões de segurança já implementadas

- Tokens e credenciais são cifrados em **AES-256-GCM** com AAD ligado ao
  contexto, de modo que um segredo movido para outra conta não decifra.
- Logs passam por sanitização que remove tokens, senhas, header `Authorization`,
  cookies e credenciais embutidas em URL de proxy.
- Toda tabela tem **RLS** por dono, com `grant` explícito — RLS decide *quais
  linhas*, grants decidem *se a tabela é alcançável*.
- Sessão validada com `getClaims()`, que confere a assinatura do JWT contra as
  chaves públicas do projeto. `getSession()` não é usado em código de servidor.

## Configuração de rede por conta

A configuração de rede é **fixa por conta**: uma conta usa sempre a mesma rota
enquanto estiver habilitada. Não há pool, rotação, troca de IP após erro nem
retry de 403 por outra rota. Proxy indisponível gera erro registrado e a
política normal de retry para indisponibilidade transitória.

Os protocolos oferecidos são os confirmados por teste de integração real contra
a versão instalada do `undici` — cada um sobe um proxy local, verifica que o
tráfego atravessou de fato e confirma que **não há fallback silencioso** para
conexão direta quando o proxy está fora do ar.

| Protocolo | Estado |
|---|---|
| `http` | estável |
| `https` | estável |
| `socks5` | funciona, mas o undici o declara **experimental** |

Sobre o `socks5`: a travessia foi comprovada em teste com undici 8.10.0, porém
o próprio undici emite `ExperimentalWarning: SOCKS5 proxy support is
experimental and subject to change`. Isso significa que uma atualização pode
alterar o comportamento sem constar como breaking change. O teste de travessia
existe justamente para detectar isso — se quebrar, o protocolo sai da lista em
`src/lib/reddit/proxy-support.ts` em vez de continuar sendo oferecido.

## Verificação pendente

Nada aqui foi executado contra a API real do Reddit. **Toda** a integração é
coberta por testes automatizados com `undici.MockAgent`, que rodam sem
credenciais — mas mock não é prova de que o formato da resposta real bate.
Estes são os pontos onde a API pode divergir, e só um teste real resolve.

Requisito comum a todos: `REDDIT_CLIENT_ID` e `REDDIT_CLIENT_SECRET`
preenchidos no `.env.local` (ver Fase -1), o que depende da aprovação da
Reddit Data API.

### 1. OAuth de ponta a ponta

Endpoints: `/api/v1/authorize`, `/api/v1/access_token`, `/api/v1/me`.

- [ ] **Conectar uma conta.** `npm run dev`, entrar no painel, acessar
      **Conectar conta**, autorizar no Reddit e confirmar o retorno a
      `/dashboard/accounts` sem erro na query string.
- [ ] **Conta aparece como Conectada** na lista.
- [ ] **`state` é de uso único:** recarregar a URL de callback (F5) e conferir
      a mensagem de solicitação expirada.
- [ ] **Tokens ficam cifrados no banco:**
      `select left(access_token_enc, 3) from public.reddit_account_secrets;`
      deve devolver `v1.`, nunca um token legível.
- [ ] **Renovação de token.** O access token do Reddit expira em cerca de uma
      hora. Deixar uma conta parada além disso e então publicar, confirmando
      que a renovação acontece sozinha e que `refresh_lock_at` volta a nulo.

### 2. Leitura de comunidades e regras

- [ ] **Sincronizar comunidades** (`/subreddits/mine/moderator`): abrir
      **Comunidades**, clicar em **Sincronizar** e conferir que as comunidades
      moderadas aparecem com o tipo de submissão correto.
- [ ] **Flairs** (`/r/{sub}/api/link_flair_v2`): confirmar o formato real da
      resposta e que a lista aparece no formulário de nova publicação.
- [ ] **Requisitos** (`/api/v1/{sub}/post_requirements`): confirmar o formato
      real e que uma comunidade que exige flair de fato bloqueia o
      agendamento sem flair.

### 3. Publicação pelo worker

Este é o bloco mais consequente: é o único que **escreve** no Reddit.

- [ ] **Publicar um link** (`/api/submit`) em uma comunidade de teste própria,
      com o worker rodando, e conferir `reddit_post_id`, `reddit_fullname` e
      permalink no Histórico.
- [ ] **Publicar um self post** e conferir o mesmo.
- [ ] **Comentário automático** (`/api/comment`): agendar publicação com
      comentário e confirmar que ele sai depois, no `reddit_fullname` correto.
- [ ] **Espaçamento entre publicações da mesma conta** é respeitado.
- [ ] **Publicação recusada pelo Reddit** (por exemplo, título fora das regras
      da comunidade) vira `failed` com a mensagem real, sem retentar.
- [ ] **Confirmar que nada é publicado em duplicidade** ao longo do teste.

> Use uma comunidade de teste sua. Um erro aqui publica de verdade.

### 4. Reconciliação da Revisão

- [ ] **Buscar candidatos** (`/user/{username}/submitted`): forçar um item em
      `needs_review` — o modo mais simples é derrubar o worker logo após um
      envio — e usar **Verificar no Reddit** na página de Revisão.
- [ ] **Confirmar o formato real do listing** e que a publicação correta
      aparece como candidata.
- [ ] **Resolver como publicada** e conferir que `resolved_by`, `resolved_at`
      e o permalink ficam gravados, e que o comentário pendente é
      materializado.

### 5. Operação

- [ ] **Worker em contêiner contra o Supabase de produção**, publicando no
      horário marcado sem intervenção.
- [ ] **Desligamento gracioso** com `docker compose stop`: o job em andamento
      termina antes de o processo sair.
- [ ] **Proxy por conta contra um proxy real de saída.** Os três protocolos já
      foram validados contra proxies locais, inclusive a ausência de fallback
      silencioso; falta confirmar com um provedor real. `socks5` segue como
      suporte experimental.

## Estado atual

**Planos 1 a 4 concluídos:** autenticação do painel, banco com RLS,
criptografia, sanitização de logs, OAuth do Reddit, gestão de contas,
configuração de rede por conta, sincronização das comunidades moderadas,
leitura de flairs e de requisitos de publicação, orçamento global de rate
limit, e agendamento de publicações com comentário automático.

**Planos 1 a 5 concluídos.** O sistema está completo: conectar contas,
sincronizar comunidades, agendar publicações com comentário automático,
publicar no horário marcado, e acompanhar tudo pelo painel — calendário, fila,
histórico, logs e revisão manual do que ficou ambíguo.

### Decisões do Plano 5 (bloco B)

- **A reconciliação lê, nunca decide.** Ela consulta as publicações da conta no
  Reddit e mostra as compatíveis; quem confirma o vínculo é você. Quando há
  mais de uma candidata, a tela destaca a ambiguidade em vez de escolher —
  duas compatíveis significam publicação duplicada ou homônimos, e nenhum dos
  dois casos se resolve por heurística.
- **Indisponibilidade nunca vira "não encontrei".** Um 5xx ao consultar sobe
  como erro; confundi-lo com lista vazia faria você marcar como falho algo que
  está publicado.
- **`resolve_needs_review` é o único caminho de saída da revisão**, e não
  republica nada. Ela exige o identificador para marcar como publicada, grava
  `resolved_by` e `resolved_at`, e cancela os comentários pendentes quando o
  desfecho é falha — sem publicação não há onde comentar.
- **Nenhuma página usa o client administrativo.** Todas leem com o client do
  usuário e deixam a RLS restringir; nenhuma filtra por `owner_id` à mão, o que
  daria aparência de segurança e esconderia uma policy afrouxada por engano.
  Um teste A/B com dois usuários reais prova a consequência em cada consulta.
- **O calendário agrupa no fuso do usuário, não no do servidor.** Uma
  publicação às 22h em São Paulo é 01h do dia seguinte em UTC, e agrupar por
  UTC a colocaria na célula errada — um erro silencioso.
- **O painel distingue worker parado de worker ocioso.** Silêncio não é falha:
  sem nada agendado o worker não registra nada. O sinal confiável é outro —
  publicações que já venceram e continuam na fila deveriam ter saído.

### Decisões do Plano 5 (bloco A)

- **`safeToRetryEffect` é separado de `disposition`.** São perguntas
  diferentes: `retryable` responde "vale a pena tentar de novo?", e
  `safeToRetryEffect` responde "repetir a operação é seguro?". Só a segunda
  autoriza limpar `submit_attempted_at` e devolver o job à fila. Amarrar isso
  à `disposition` faria qualquer classificação futura como retentável virar,
  sem que ninguém percebesse, permissão para republicar.
- **O worker verifica o orçamento antes do claim, nunca depois.** Esperar o
  reset segurando um job em `processing` deixaria o reaper de outra instância
  recuperá-lo, e dois workers publicariam o mesmo conteúdo. Para o caso
  irredutível — um job que sozinho demora mais que o timeout — existe o
  heartbeat, que renova o lock enquanto o job está vivo.
- **A chave secreta é lida em exatamente três arquivos.** O módulo
  compartilhado é uma factory pura que recebe URL e chave por parâmetro;
  `admin.ts` (marcado `server-only`) e `worker/supabase.ts` (fora da árvore do
  Next) são os únicos que leem o ambiente. Um teste percorre o grafo de
  imports de cada arquivo `'use client'` para provar que nenhum os alcança.
- **Conexão derrubada depois do POST tem teste determinístico local**, com um
  servidor que lê o corpo inteiro e só então destrói o socket. Provocar isso
  contra a API real seria publicar de verdade para testar.
- **Erro de banco no worker precisa gritar.** O `supabase-js` devolve falhas em
  `error` em vez de lançar; ignorá-las fazia um worker sem banco parecer um
  worker ocioso e saudável — o pior modo de falha para um agendador.

### Decisões do Plano 4

- **Link e texto na mesma publicação é impossível na API do Reddit.** Quando o
  usuário fornece os dois, o texto vira comentário automático — usando
  endpoint oficial, e apenas com confirmação explícita no formulário.
- **Horário inexistente por horário de verão é recusado**, nunca deslocado em
  silêncio: publicar uma hora depois do combinado sem avisar seria pior que
  pedir outro horário. Horário que ocorre duas vezes exige escolha explícita,
  com o offset de cada opção — o algoritmo não pressupõe transição de uma
  hora, então funciona em fusos como Lord Howe, que muda 30 minutos.
- **As tabelas de agendamento são somente leitura pelo Data API.**
  `authenticated` tem apenas `SELECT`; criar, reagendar e cancelar passam por
  RPCs que só o `service_role` executa. Isso existe porque a validação de
  `post_requirements` depende de uma chamada externa ao Reddit e não pode ser
  reproduzida dentro do SQL — sem essa restrição, o cliente agendaria sem ela.
- **O dono de uma publicação vem sempre de `requireUser()`**, nunca de campo
  de formulário. As RPCs recebem o owner já verificado e revalidam que conta e
  comunidade pertencem a ele, porque `service_role` ignora RLS.
- **Publicação e comentário nascem na mesma transação.** Dois inserts
  sequenciais deixariam um post órfão se o segundo falhasse, e o worker
  publicaria sem o comentário pedido.
- **A máquina de estados vive em triggers**: `needs_review` não volta para a
  fila, `published` e `cancelled` são terminais, e `processing` só retorna à
  fila quando o envio comprovadamente não saiu.
- **Comentário com horário absoluto já vencido não é descartado.** Se a fila
  atrasar, o comentário fica elegível logo após a publicação — o usuário
  pediu "às 15h", e publicar às 15h30 não torna o comentário indesejado.

### Decisões do Plano 3

- Comunidades são um espelho da API, não entrada do usuário: `authenticated`
  tem apenas `SELECT` sobre `subreddits`. Comunidades que somem viram
  `removed`, nunca são apagadas, porque publicações agendadas apontam para elas.
- **Falha ao ler regras nunca vira permissão.** Se `post_requirements` ou
  `link_flair_v2` não puderem ser lidos, a operação falha com mensagem clara em
  vez de assumir "sem restrições" — assumir liberaria exatamente a publicação
  que o Reddit vai recusar. Lista vazia só é resultado quando o Reddit
  respondeu com sucesso.
- Os requisitos lidos da API **não** cobrem regras de AutoModerator. Uma
  publicação pode passar por toda a validação local e ainda ser recusada na
  submissão — a resposta do Reddit é sempre a autoridade final.
- O orçamento de requisições é global por `client_id`, com reserva atômica em
  função SQL. Enquanto o saldo é desconhecido, apenas uma requisição fica em
  voo; se o mecanismo de orçamento estiver indisponível, a chamada externa não
  acontece (fail-closed).

## Proteção de processo

Um hook de pre-commit (`.githooks/pre-commit`, instalado por `npm install` via
`prepare`) bloqueia commits com a verificação quebrada:

- sempre: `lint`, `typecheck` e a suíte sem banco — os mesmos passos do CI,
  poucos segundos, sem exigir Docker;
- condicionalmente: os testes de banco, **apenas** quando o Supabase local
  responde, para não travar quem está sem o stack no ar.

Para pular deliberadamente (WIP, rebase): `git commit --no-verify`.
