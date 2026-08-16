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

## Verificação

```bash
npm run verify   # lint + typecheck + testes + npm audit
```

Os testes de integração exigem o stack local do Supabase no ar
(`npx supabase start`). Para rodar apenas os testes que não tocam no banco:

```bash
npm test -- --exclude "tests/db/**"
```

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

## Estado atual

**Plano 1 concluído:** autenticação do painel, banco com RLS, criptografia e
sanitização de logs. As demais funcionalidades chegam nos Planos 2 a 5:

| Plano | Escopo |
|---|---|
| 2 | OAuth do Reddit, contas, configuração de rede por conta |
| 3 | Comunidades, flairs, requisitos de publicação |
| 4 | Criar e agendar publicações, comentários programados |
| 5 | Worker de publicação, calendário, fila, histórico |
