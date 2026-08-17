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

Uma etapa do Plano 2 **não pôde ser executada** e continua em aberto:

- [ ] **Sincronização de comunidades contra a API real.** Depende das mesmas
      credenciais do item abaixo. Roteiro: conectar uma conta, abrir
      **Comunidades**, clicar em **Sincronizar**, e conferir que as comunidades
      moderadas aparecem com o tipo de submissão correto. Confirmar também o
      formato real de `link_flair_v2` e de `post_requirements` — são os únicos
      pontos onde a API pode divergir dos mocks.

- [ ] **Fluxo OAuth de ponta a ponta com o Reddit real.** Requer
      `REDDIT_CLIENT_ID` e `REDDIT_CLIENT_SECRET` preenchidos no `.env.local`
      (ver Fase -1). Roteiro:
      1. `npm run dev`, entrar no painel e acessar **Conectar conta**;
      2. autorizar no Reddit e confirmar o retorno a `/dashboard/accounts`
         sem erro na query string;
      3. conferir que a conta aparece com status **Conectada**;
      4. recarregar a URL de callback (F5) e confirmar a mensagem de
         solicitação expirada — o `state` é de uso único;
      5. conferir no banco que os tokens estão cifrados:
         `select left(access_token_enc, 3) from public.reddit_account_secrets;`
         deve devolver `v1.`, nunca um token legível.

Todo o resto do Plano 2 está coberto por testes automatizados, que rodam sem
credenciais reais: a API do Reddit é simulada com `undici.MockAgent`.

## Estado atual

**Planos 1 a 4 concluídos:** autenticação do painel, banco com RLS,
criptografia, sanitização de logs, OAuth do Reddit, gestão de contas,
configuração de rede por conta, sincronização das comunidades moderadas,
leitura de flairs e de requisitos de publicação, orçamento global de rate
limit, e agendamento de publicações com comentário automático.

**Plano 5, bloco A concluído:** o worker publica de verdade — claim atômico,
reaper, heartbeat de lock, submissão de publicação e de comentário, backoff, e
empacotamento em Docker. Falta o bloco B:

| Plano | Escopo |
|---|---|
| 5B | Reconciliação, Revisão, Fila, Histórico, Calendário, Dashboard |

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
