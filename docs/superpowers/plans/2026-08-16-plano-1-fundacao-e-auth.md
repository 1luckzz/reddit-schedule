# Reddit Post Scheduler — Plano 1: Fundação e Autenticação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o esqueleto do painel funcionando de ponta a ponta — login, dashboard protegido, banco com RLS — mais os dois utilitários de segurança (criptografia e sanitização de logs) que todas as fases seguintes consomem.

**Architecture:** Next.js 16 App Router com `src/`, Supabase Postgres + Auth via `@supabase/ssr`. Sessão renovada no arquivo `proxy.ts` (o antigo `middleware.ts`, renomeado no Next 16) e validada com `getClaims()`, que confere a assinatura do JWT contra as chaves públicas do projeto. Toda tabela nasce com RLS por `owner_id`. Segredos são cifrados em AES-256-GCM com AAD ligado ao contexto, e nenhum valor sensível chega a log.

**Tech Stack:** Next.js 16.3.1, React, TypeScript strict, Tailwind CSS 4.3, `@supabase/ssr` 0.12.4, `@supabase/supabase-js` 2.112.3, Zod 4.4.3, Vitest 4.1.10, Supabase CLI 2.114.0, Node 24.

**Spec:** `docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md` (revisão 2, aprovada)

**Fases da spec cobertas:** -1 (acesso à Reddit API, documentação), 0 (fundação), 1 (auth do painel).

## Global Constraints

Valores copiados literalmente da spec. Valem para toda task deste plano e dos seguintes.

- **Timezone padrão:** `America/Sao_Paulo`. `scheduled_at` é sempre `timestamptz` (UTC no banco); a coluna `timezone` guarda o fuso apenas para exibir e reeditar.
- **RLS:** habilitada em toda tabela do schema `public`. Policies sempre com `TO authenticated` **mais** predicado de posse — `TO authenticated` sozinho é IDOR. Policies de `UPDATE` sempre com `USING` **e** `WITH CHECK`.
- **Performance de RLS:** usar `(select auth.uid())`, nunca `auth.uid()` direto no predicado.
- **Tabelas de segredo** (`reddit_account_secrets`, `reddit_account_network_configs`, `oauth_states`): RLS habilitada, **zero policies e zero grants** para `anon`/`authenticated`.
- **Chave pública do cliente:** `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. A chave secreta (`service_role`) **nunca** recebe prefixo `NEXT_PUBLIC_`.
- **Sessão no servidor:** sempre `supabase.auth.getClaims()`. **Nunca** `getSession()` em código de servidor.
- **Funções SQL:** `security invoker` por padrão e sempre `set search_path = ''`. `security definer` só quando indispensável, e sempre com checagem explícita de posse no corpo.
- **Criptografia:** AES-256-GCM, chave de 32 bytes em `ENCRYPTION_KEY` (base64).
- **Proibido em qualquer log:** access token, refresh token, client secret, senha de proxy, header `Authorization`, cookies, URL de proxy com credenciais.
- **`undici`:** piso `^8.10.0`. `fetch` e `ProxyAgent` sempre importados da mesma dependência instalada, nunca do `fetch` global do Node.
- **Nenhum mecanismo de bypass** de rate limit, ban, CAPTCHA ou bloqueio, em nenhuma task, em nenhuma hipótese.
- **Portão de fase:** `npm run verify` (lint + typecheck + test + audit) verde antes de encerrar cada task.

---

## Pré-requisito da Fase -1 (executado pelo usuário, fora do código)

Documentado na Task 9. O desenvolvimento das Tasks 1–8 **não depende** de credenciais do Reddit; elas só passam a ser necessárias no Plano 2.

---

### Task 1: Scaffold do projeto e toolchain de verificação

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css` (via `create-next-app`)
- Create: `vitest.config.ts`
- Create: `tests/smoke.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nada (primeira task)
- Produces: scripts `npm run lint`, `npm run typecheck`, `npm run test`, `npm run verify`; alias `@/*` → `src/*`

- [ ] **Step 1: Preservar os docs e rodar o scaffold**

`create-next-app` recusa diretórios com arquivos não reconhecidos. `docs/` não está na lista de arquivos tolerados, então sai e volta.

```powershell
Move-Item C:\reddit-scheduler\docs C:\reddit-scheduler\..\_docs_tmp
npx create-next-app@16.3.1 . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes
Move-Item C:\reddit-scheduler\..\_docs_tmp C:\reddit-scheduler\docs
```

Se o `create-next-app` ainda reclamar de diretório não vazio, verifique o que sobrou com `Get-ChildItem -Force` — apenas `.git`, `.gitignore` e `docs` deveriam existir antes do comando.

- [ ] **Step 2: Instalar as dependências de teste**

```powershell
npm install -D vitest@4.1.10 vite-tsconfig-paths @vitest/coverage-v8
```

- [ ] **Step 3: Criar a configuração do Vitest**

Ambiente `node`: neste plano os testes são de lógica e de banco, não de componentes React.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    setupFiles: [],
  },
})
```

- [ ] **Step 4: Escrever o teste de fumaça**

```ts
// tests/smoke.test.ts
import { describe, expect, it } from 'vitest'

describe('toolchain', () => {
  it('resolve o alias @/ para src/', async () => {
    const mod = await import('@/app/layout')
    expect(mod.default).toBeTypeOf('function')
  })
})
```

- [ ] **Step 5: Rodar o teste e ver falhar**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL — o Vitest ainda não está referenciado nos scripts e/ou o alias não resolve antes do plugin ser aplicado. Se passar de primeira, siga adiante; o objetivo do step é confirmar que o runner executa.

- [ ] **Step 6: Adicionar os scripts de verificação**

Em `package.json`, substitua o bloco `scripts` por:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "audit": "npm audit --audit-level=high",
    "verify": "npm run lint && npm run typecheck && npm run test && npm run audit"
  }
}
```

- [ ] **Step 7: Rodar a verificação completa**

Run: `npm run verify`
Expected: PASS nos quatro passos. Corrija o que falhar antes de commitar — este é o portão de todas as tasks seguintes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 16 com TypeScript, Tailwind e Vitest"
```

---

### Task 2: Validação de ambiente com Zod

**Files:**
- Create: `src/lib/config/env.ts`
- Create: `.env.example`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - `getCoreEnv(): CoreEnv` — `{ NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, ENCRYPTION_KEY, APP_URL }`
  - `getRedditEnv(): RedditEnv` — `{ REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_REDIRECT_URI, REDDIT_USER_AGENT }`
  - Ambas lançam `EnvError` com a lista de variáveis inválidas.

As duas funções são separadas de propósito: as Tasks 1–8 não têm credenciais do Reddit, e exigi-las na inicialização impediria o painel de subir antes do Plano 2.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/config/env.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const VALID_KEY = Buffer.alloc(32, 7).toString('base64')

function loadEnv() {
  vi.resetModules()
  return import('@/lib/config/env')
}

describe('getCoreEnv', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x'
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_x'
    process.env.ENCRYPTION_KEY = VALID_KEY
    process.env.APP_URL = 'http://localhost:3000'
  })

  it('devolve o ambiente quando tudo é válido', async () => {
    const { getCoreEnv } = await loadEnv()
    expect(getCoreEnv().APP_URL).toBe('http://localhost:3000')
  })

  it('rejeita ENCRYPTION_KEY que não tem 32 bytes', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64')
    const { getCoreEnv } = await loadEnv()
    expect(() => getCoreEnv()).toThrow(/ENCRYPTION_KEY/)
  })

  it('lista todas as variáveis faltando de uma vez', async () => {
    delete process.env.SUPABASE_SECRET_KEY
    delete process.env.APP_URL
    const { getCoreEnv } = await loadEnv()
    expect(() => getCoreEnv()).toThrow(/SUPABASE_SECRET_KEY[\s\S]*APP_URL|APP_URL[\s\S]*SUPABASE_SECRET_KEY/)
  })
})

describe('getRedditEnv', () => {
  it('falha de forma independente do core quando ausente', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x'
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_x'
    process.env.ENCRYPTION_KEY = VALID_KEY
    process.env.APP_URL = 'http://localhost:3000'
    delete process.env.REDDIT_CLIENT_ID
    const { getCoreEnv, getRedditEnv } = await loadEnv()
    expect(() => getCoreEnv()).not.toThrow()
    expect(() => getRedditEnv()).toThrow(/REDDIT_CLIENT_ID/)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/config/env.test.ts`
Expected: FAIL — `Cannot find module '@/lib/config/env'`

- [ ] **Step 3: Implementar**

```ts
// src/lib/config/env.ts
import { z } from 'zod'

export class EnvError extends Error {
  constructor(issues: string[]) {
    super(`Variáveis de ambiente inválidas:\n${issues.join('\n')}`)
    this.name = 'EnvError'
  }
}

const base64Key32 = z
  .string()
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32
    } catch {
      return false
    }
  }, 'ENCRYPTION_KEY deve ser exatamente 32 bytes codificados em base64')

// Zod 4: os validadores de formato são funções de topo (z.url(), z.email()).
// As formas antigas (z.string().url()) ainda funcionam, mas estão depreciadas.
const coreSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  ENCRYPTION_KEY: base64Key32,
  APP_URL: z.url(),
})

const redditSchema = z.object({
  REDDIT_CLIENT_ID: z.string().min(1),
  REDDIT_CLIENT_SECRET: z.string().min(1),
  REDDIT_REDIRECT_URI: z.url(),
  REDDIT_USER_AGENT: z.string().min(1),
})

export type CoreEnv = z.infer<typeof coreSchema>
export type RedditEnv = z.infer<typeof redditSchema>

function parse<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `- ${i.path.join('.')}: ${i.message}`,
    )
    throw new EnvError(issues)
  }
  return result.data
}

export function getCoreEnv(): CoreEnv {
  return parse(coreSchema, process.env)
}

export function getRedditEnv(): RedditEnv {
  return parse(redditSchema, process.env)
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/config/env.test.ts`
Expected: PASS (4 testes)

- [ ] **Step 5: Escrever o `.env.example`**

Nenhum valor real. `SUPABASE_SECRET_KEY` e `ENCRYPTION_KEY` jamais recebem prefixo `NEXT_PUBLIC_`.

```bash
# .env.example
# ---- Supabase ----
# Local: obtenha com `npx supabase status`
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
# Chave secreta (service_role). NUNCA prefixar com NEXT_PUBLIC_.
SUPABASE_SECRET_KEY=

# ---- Aplicação ----
APP_URL=http://localhost:3000
# 32 bytes em base64. Gere com:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY=

# ---- Reddit (necessário a partir do Plano 2) ----
# Ver README, seção "Fase -1: acesso à Reddit Data API"
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_REDIRECT_URI=http://localhost:3000/api/reddit/callback
REDDIT_USER_AGENT=web:reddit-scheduler:0.1.0 (by /u/SEU_USUARIO)

# ---- Worker (necessário a partir do Plano 4) ----
WORKER_INTERVAL_SECONDS=30
WORKER_ID=worker-local
```

- [ ] **Step 6: Verificar e commitar**

Run: `npm run verify`
Expected: PASS

```bash
git add -A
git commit -m "feat: validacao de ambiente com Zod e .env.example"
```

---

### Task 3: Criptografia AES-256-GCM

**Files:**
- Create: `src/lib/crypto/aes-gcm.ts`
- Test: `tests/crypto/aes-gcm.test.ts`

**Interfaces:**
- Consumes: `getCoreEnv()` da Task 2
- Produces:
  - `encryptSecret(plaintext: string, aad: string): string` — devolve `v1.<iv>.<tag>.<ciphertext>` em base64url
  - `decryptSecret(payload: string, aad: string): string`
  - `class DecryptionError extends Error`

O `aad` (dados adicionais autenticados) amarra o texto cifrado ao seu contexto — por exemplo `reddit_account_secrets:refresh_token:<accountId>`. Sem ele, alguém com acesso de escrita ao banco poderia mover o token cifrado da conta A para a linha da conta B e o sistema o decifraria normalmente. Com ele, a decifragem falha.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/crypto/aes-gcm.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'

const AAD = 'reddit_account_secrets:refresh_token:acc-1'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('encryptSecret / decryptSecret', () => {
  it('faz round-trip do texto original', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto/aes-gcm')
    const secret = 'refresh-token-super-secreto'
    expect(decryptSecret(encryptSecret(secret, AAD), AAD)).toBe(secret)
  })

  it('produz saídas diferentes para a mesma entrada (IV aleatório)', async () => {
    const { encryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(encryptSecret('x', AAD)).not.toBe(encryptSecret('x', AAD))
  })

  it('não deixa o texto claro aparecer no payload', async () => {
    const { encryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(encryptSecret('token-visivel', AAD)).not.toContain('token-visivel')
  })

  it('recusa decifrar com AAD de outra conta', async () => {
    const { encryptSecret, decryptSecret, DecryptionError } = await import(
      '@/lib/crypto/aes-gcm'
    )
    const payload = encryptSecret('segredo', AAD)
    expect(() =>
      decryptSecret(payload, 'reddit_account_secrets:refresh_token:acc-2'),
    ).toThrow(DecryptionError)
  })

  it('recusa payload adulterado', async () => {
    const { encryptSecret, decryptSecret, DecryptionError } = await import(
      '@/lib/crypto/aes-gcm'
    )
    const payload = encryptSecret('segredo', AAD)
    const parts = payload.split('.')
    const bytes = Buffer.from(parts[3], 'base64url')
    bytes[0] ^= 0xff
    parts[3] = bytes.toString('base64url')
    expect(() => decryptSecret(parts.join('.'), AAD)).toThrow(DecryptionError)
  })

  it('recusa payload com versão desconhecida', async () => {
    const { decryptSecret, DecryptionError } = await import('@/lib/crypto/aes-gcm')
    expect(() => decryptSecret('v9.a.b.c', AAD)).toThrow(DecryptionError)
  })

  it('a mensagem de erro nunca inclui a chave nem o texto claro', async () => {
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto/aes-gcm')
    const payload = encryptSecret('texto-claro-sensivel', AAD)
    try {
      decryptSecret(payload, 'aad-errado')
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain('texto-claro-sensivel')
      expect(msg).not.toContain(process.env.ENCRYPTION_KEY)
    }
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/crypto/aes-gcm.test.ts`
Expected: FAIL — `Cannot find module '@/lib/crypto/aes-gcm'`

- [ ] **Step 3: Implementar**

```ts
// src/lib/crypto/aes-gcm.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { getCoreEnv } from '@/lib/config/env'

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`Falha ao decifrar o segredo: ${reason}`)
    this.name = 'DecryptionError'
  }
}

function key(): Buffer {
  return Buffer.from(getCoreEnv().ENCRYPTION_KEY, 'base64')
}

export function encryptSecret(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decryptSecret(payload: string, aad: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4) throw new DecryptionError('formato inválido')
  const [version, ivB64, tagB64, ctB64] = parts
  if (version !== VERSION) throw new DecryptionError('versão não suportada')

  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('formato inválido')
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // A causa original é omitida de propósito: ela pode conter fragmentos
    // do material criptográfico.
    throw new DecryptionError('autenticação falhou')
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/crypto/aes-gcm.test.ts`
Expected: PASS (7 testes)

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: criptografia AES-256-GCM com AAD por contexto"
```

---

### Task 4: Sanitização de logs

**Files:**
- Create: `src/lib/logging/sanitize.ts`
- Test: `tests/logging/sanitize.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - `sanitize(value: unknown): unknown` — clona removendo segredos, recursivamente
  - `maskHost(host: string): string` — `proxy.exemplo.com` → `pr***.exemplo.com`, `203.0.113.9` → `203.0.113.***`

`maskHost` mora aqui porque é a mesma regra de mascaramento usada pelo trigger SQL da Task 5 do Plano 2; manter as duas implementações lado a lado no mesmo conceito evita divergência.

- [ ] **Step 1: Escrever os testes falhando**

```ts
// tests/logging/sanitize.test.ts
import { describe, expect, it } from 'vitest'
import { maskHost, sanitize } from '@/lib/logging/sanitize'

const REDACTED = '[REDACTED]'

describe('sanitize', () => {
  it('remove todas as chaves sensíveis conhecidas', () => {
    const input = {
      access_token: 'AT-123',
      refresh_token: 'RT-456',
      client_secret: 'CS-789',
      proxy_password: 'PP-000',
      authorization: 'bearer AT-123',
      cookie: 'sb-x-auth-token=abc',
      title: 'Meu post',
    }
    const out = sanitize(input) as Record<string, unknown>
    expect(out.access_token).toBe(REDACTED)
    expect(out.refresh_token).toBe(REDACTED)
    expect(out.client_secret).toBe(REDACTED)
    expect(out.proxy_password).toBe(REDACTED)
    expect(out.authorization).toBe(REDACTED)
    expect(out.cookie).toBe(REDACTED)
    expect(out.title).toBe('Meu post')
  })

  it('reconhece variações de caixa e separador', () => {
    const out = sanitize({
      'Authorization': 'bearer x',
      'Access-Token': 'y',
      accessToken: 'z',
      PROXY_PASSWORD: 'w',
    }) as Record<string, unknown>
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true)
  })

  it('desce em objetos aninhados e arrays', () => {
    const out = sanitize({
      accounts: [{ secrets: { refresh_token: 'RT' } }],
    }) as { accounts: { secrets: { refresh_token: string } }[] }
    expect(out.accounts[0].secrets.refresh_token).toBe(REDACTED)
  })

  it('remove credenciais embutidas em URL de proxy', () => {
    const out = sanitize({
      note: 'usando socks5://usuario:senha@proxy.exemplo.com:1080 agora',
    }) as { note: string }
    expect(out.note).not.toContain('senha')
    expect(out.note).not.toContain('usuario')
    expect(out.note).toContain('socks5://')
  })

  it('remove tokens bearer soltos em texto livre', () => {
    const out = sanitize('falhou com Authorization: bearer eyJhbGciOiJIUzI1') as string
    expect(out).not.toContain('eyJhbGciOiJIUzI1')
  })

  it('preserva o formato de Error mas sanitiza a mensagem', () => {
    const out = sanitize(new Error('bearer eyJabc falhou')) as {
      name: string
      message: string
    }
    expect(out.name).toBe('Error')
    expect(out.message).not.toContain('eyJabc')
  })

  it('não entra em laço infinito com referência circular', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(() => sanitize(a)).not.toThrow()
  })
})

describe('maskHost', () => {
  it('mascara hostname preservando o domínio', () => {
    expect(maskHost('proxy.exemplo.com')).toBe('pr***.exemplo.com')
  })

  it('mascara o último octeto de um IPv4', () => {
    expect(maskHost('203.0.113.9')).toBe('203.0.113.***')
  })

  it('mascara host curto por inteiro', () => {
    expect(maskHost('a.b')).toBe('***.b')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/logging/sanitize.test.ts`
Expected: FAIL — `Cannot find module '@/lib/logging/sanitize'`

- [ ] **Step 3: Implementar**

```ts
// src/lib/logging/sanitize.ts
const REDACTED = '[REDACTED]'

const SENSITIVE_KEY = /(access[_-]?token|refresh[_-]?token|client[_-]?secret|proxy[_-]?password|password|authorization|cookie|set[_-]?cookie|encryption[_-]?key|secret[_-]?key|api[_-]?key)/i

// usuario:senha@host  ->  ***:***@host
const URL_CREDENTIALS = /([a-z0-9+.-]+:\/\/)[^/\s:@]+:[^/\s@]+@/gi
// bearer <token>
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi

function sanitizeString(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`)
    .replace(BEARER, `$1 ${REDACTED}`)
}

export function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(item, seen)
  }
  return out
}

export function maskHost(host: string): string {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.***`

  const dot = host.indexOf('.')
  if (dot === -1) return '***'

  const label = host.slice(0, dot)
  const rest = host.slice(dot)
  if (label.length <= 2) return `***${rest}`
  return `${label.slice(0, 2)}***${rest}`
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/logging/sanitize.test.ts`
Expected: PASS (10 testes)

- [ ] **Step 5: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: sanitizacao de logs e mascaramento de host"
```

---

### Task 5: Supabase local e migration inicial (`profiles`)

**Files:**
- Create: `supabase/config.toml` (via `supabase init`)
- Create: `supabase/migrations/<timestamp>_initial_profiles.sql`
- Create: `tests/db/helpers.ts`
- Test: `tests/db/profiles.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - tabela `public.profiles` com RLS
  - funções `public.set_updated_at()` e `public.handle_new_user()`
  - helpers de teste: `adminClient()`, `createTestUser(email)`, `userClient(accessToken)`, `cleanupTestUsers()`

**Pré-requisito:** Docker Desktop rodando.

- [ ] **Step 1: Inicializar e subir o Supabase local**

```powershell
npx supabase init
npx supabase start
npx supabase status
```

Anote `API URL`, a publishable key e a secret key impressas por `status` e preencha `.env.local`. Confirme a versão do CLI com `npx supabase --version` (esperado 2.114.0 ou superior).

- [ ] **Step 2: Criar o arquivo de migration pelo CLI**

Nunca invente o nome do arquivo — o CLI gera o timestamp correto.

```powershell
npx supabase migration new initial_profiles
```

- [ ] **Step 3: Escrever o teste de integração falhando**

```ts
// tests/db/helpers.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const SECRET = process.env.SUPABASE_SECRET_KEY!

export function adminClient(): SupabaseClient {
  return createClient(URL, SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function createTestUser(email: string) {
  const admin = adminClient()
  const password = 'senha-de-teste-123456'
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) throw error

  const anon = createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false },
  })
  const signIn = await anon.auth.signInWithPassword({ email, password })
  if (signIn.error) throw signIn.error

  return {
    id: data.user!.id,
    accessToken: signIn.data.session!.access_token,
  }
}

export function userClient(accessToken: string): SupabaseClient {
  return createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

export async function cleanupTestUsers(ids: string[]) {
  const admin = adminClient()
  for (const id of ids) {
    await admin.auth.admin.deleteUser(id)
  }
}
```

```ts
// tests/db/profiles.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }

beforeAll(async () => {
  userA = await createTestUser(`a-${Date.now()}@teste.local`)
  userB = await createTestUser(`b-${Date.now()}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('profiles', () => {
  it('cria o profile automaticamente no signup', async () => {
    const { data, error } = await adminClient()
      .from('profiles')
      .select('id, timezone, log_retention_days')
      .eq('id', userA.id)
      .single()
    expect(error).toBeNull()
    expect(data!.timezone).toBe('America/Sao_Paulo')
    expect(data!.log_retention_days).toBe(30)
  })

  it('o usuário lê o próprio profile', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('profiles')
      .select('id')
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(userA.id)
  })

  it('o usuário A não enxerga o profile do usuário B', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('profiles')
      .select('id')
      .eq('id', userB.id)
    expect(data).toHaveLength(0)
  })

  it('o usuário atualiza o próprio timezone', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('profiles')
      .update({ timezone: 'UTC' })
      .eq('id', userA.id)
    expect(error).toBeNull()
  })

  it('o usuário A não atualiza o profile do usuário B', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('profiles')
      .update({ timezone: 'UTC' })
      .eq('id', userB.id)
      .select()
    expect(data).toHaveLength(0)
  })

  it('updated_at avança a cada update', async () => {
    const admin = adminClient()
    const before = await admin
      .from('profiles')
      .select('updated_at')
      .eq('id', userB.id)
      .single()
    await new Promise((r) => setTimeout(r, 1100))
    await admin.from('profiles').update({ log_retention_days: 45 }).eq('id', userB.id)
    const after = await admin
      .from('profiles')
      .select('updated_at')
      .eq('id', userB.id)
      .single()
    expect(new Date(after.data!.updated_at).getTime()).toBeGreaterThan(
      new Date(before.data!.updated_at).getTime(),
    )
  })
})
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `npx vitest run tests/db/profiles.test.ts`
Expected: FAIL — a relação `profiles` não existe.

- [ ] **Step 5: Escrever a migration**

No arquivo criado no Step 2:

```sql
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
-- Não recebe entrada do usuário: só usa new.id.
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

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

O `revoke execute` importa: o Postgres concede `EXECUTE` a `PUBLIC` por padrão, e uma função `security definer` em `public` seria um endpoint chamável por qualquer role.

- [ ] **Step 6: Aplicar a migration e rodar os testes**

```powershell
npx supabase db reset
npx vitest run tests/db/profiles.test.ts
```

Expected: PASS (6 testes)

- [ ] **Step 7: Rodar os advisors de segurança**

```powershell
npx supabase db advisors --local
```

Expected: nenhum aviso de RLS desabilitada nem de `search_path` mutável. Corrija o que aparecer antes de commitar.

- [ ] **Step 8: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: supabase local e migration inicial de profiles com RLS"
```

---

### Task 6: Clients Supabase e renovação de sessão

**Files:**
- Create: `src/lib/supabase/client.ts` (browser)
- Create: `src/lib/supabase/server.ts` (server components e actions)
- Create: `src/lib/supabase/admin.ts` (secret key)
- Create: `src/lib/supabase/proxy.ts` (renovação de sessão)
- Create: `src/proxy.ts` (arquivo de convenção do Next 16)
- Test: `tests/supabase/admin.test.ts`

**Interfaces:**
- Consumes: `getCoreEnv()` da Task 2
- Produces:
  - `createBrowserSupabase(): SupabaseClient`
  - `createServerSupabase(): Promise<SupabaseClient>`
  - `createAdminSupabase(): SupabaseClient`
  - `updateSession(request: NextRequest): Promise<NextResponse>`

**Atenção:** no Next 16 o arquivo de convenção chama-se `proxy.ts`, não `middleware.ts`, e exporta `proxy`. A validação de sessão é `getClaims()` — ela confere a assinatura do JWT contra as chaves públicas do projeto a cada chamada. `getSession()` não revalida o token e **não deve ser usado em código de servidor**.

- [ ] **Step 1: Instalar as dependências do Supabase**

```powershell
npm install @supabase/ssr@0.12.4 @supabase/supabase-js@2.112.3
```

- [ ] **Step 2: Escrever o teste falhando**

O teste protege a regra mais fácil de violar por acidente: a secret key não pode vazar para o bundle do cliente.

```ts
// tests/supabase/admin.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('client administrativo', () => {
  it('é marcado como server-only', () => {
    const source = readFileSync('src/lib/supabase/admin.ts', 'utf8')
    expect(source).toContain("import 'server-only'")
  })

  it('nunca lê uma variável NEXT_PUBLIC_ para a chave secreta', () => {
    const source = readFileSync('src/lib/supabase/admin.ts', 'utf8')
    expect(source).toContain('SUPABASE_SECRET_KEY')
    expect(source).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SECRET/)
  })

  it('cria um client sem persistir sessão', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x'
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_x'
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64')
    process.env.APP_URL = 'http://localhost:3000'
    const { createAdminSupabase } = await import('@/lib/supabase/admin')
    expect(createAdminSupabase()).toBeDefined()
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/supabase/admin.test.ts`
Expected: FAIL — `Cannot find module '@/lib/supabase/admin'`

- [ ] **Step 4: Instalar o pacote `server-only` e implementar os clients**

```powershell
npm install server-only
```

```ts
// src/lib/supabase/client.ts
import { createBrowserClient } from '@supabase/ssr'

export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}
```

```ts
// src/lib/supabase/server.ts
import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getCoreEnv } from '@/lib/config/env'

export async function createServerSupabase() {
  const env = getCoreEnv()
  const cookieStore = await cookies()

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet, _headers) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Chamado de um Server Component, onde não se pode escrever
            // cookies. Ignorável: o proxy renova a sessão a cada request.
          }
        },
      },
    },
  )
}
```

```ts
// src/lib/supabase/admin.ts
import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { getCoreEnv } from '@/lib/config/env'

/**
 * Client com a chave secreta: IGNORA RLS.
 * Nunca chame isto com um id vindo do cliente sem antes verificar a posse
 * com os helpers de src/lib/auth/ownership.ts (Plano 2).
 */
export function createAdminSupabase() {
  const env = getCoreEnv()
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
```

```ts
// src/lib/supabase/proxy.ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/login', '/signup', '/auth', '/api/health']

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  // Com Fluid compute, nunca guarde este client num global: crie um por request.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
          Object.entries(headers).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value),
          )
        },
      },
    },
  )

  // Não coloque código entre createServerClient e getClaims(): um erro aqui
  // provoca logout aleatório de usuários e é dificílimo de depurar.
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims

  const isPublic = PUBLIC_PATHS.some((p) =>
    request.nextUrl.pathname.startsWith(p),
  )

  if (!claims && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // O objeto supabaseResponse precisa ser devolvido como está, sob pena de
  // dessincronizar os cookies entre navegador e servidor.
  return supabaseResponse
}
```

```ts
// src/proxy.ts
import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/supabase/admin.test.ts`
Expected: PASS (3 testes)

- [ ] **Step 6: Confirmar que o Next reconhece o arquivo de proxy**

```powershell
npm run dev
```

Abra `http://localhost:3000/dashboard`. Esperado: redirecionamento para `/login` (que ainda dá 404 — a página chega na Task 7). O redirecionamento é a prova de que o `proxy.ts` está ativo.

Se não redirecionar, confirme a localização do arquivo: com `--src-dir`, o Next espera `src/proxy.ts`. Consulte `https://nextjs.org/docs/app/api-reference/file-conventions/proxy` antes de mover.

- [ ] **Step 7: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: clients supabase e renovacao de sessao via proxy"
```

---

### Task 7: Login, cadastro e logout

**Files:**
- Create: `src/lib/auth/require-user.ts`
- Create: `src/app/(auth)/login/schema.ts`
- Create: `src/app/(auth)/login/page.tsx`
- Create: `src/app/(auth)/login/actions.ts`
- Create: `src/app/auth/signout/route.ts`
- Test: `tests/auth/validation.test.ts`

**Interfaces:**
- Consumes: `createServerSupabase()` da Task 6
- Produces:
  - `requireUser(): Promise<{ id: string; email: string }>` — lança `UnauthenticatedError` se não houver sessão válida
  - `credentialsSchema` — Zod, em `schema.ts`
  - server actions `signIn(prev, formData)` e `signUp(prev, formData)`, em `actions.ts`

**Atenção:** o schema mora num arquivo separado de propósito. Um módulo marcado
com `'use server'` só pode exportar funções assíncronas — exportar um objeto Zod
dali quebra o build do Next.

- [ ] **Step 1: Escrever o teste de validação falhando**

```ts
// tests/auth/validation.test.ts
import { describe, expect, it } from 'vitest'
import { credentialsSchema } from '@/app/(auth)/login/schema'

describe('credentialsSchema', () => {
  it('aceita credenciais válidas', () => {
    const r = credentialsSchema.safeParse({
      email: 'user@exemplo.com',
      password: 'senha-forte-123',
    })
    expect(r.success).toBe(true)
  })

  it('rejeita email malformado', () => {
    const r = credentialsSchema.safeParse({
      email: 'nao-e-email',
      password: 'senha-forte-123',
    })
    expect(r.success).toBe(false)
  })

  it('rejeita senha com menos de 8 caracteres', () => {
    const r = credentialsSchema.safeParse({
      email: 'user@exemplo.com',
      password: '1234567',
    })
    expect(r.success).toBe(false)
  })

  it('normaliza o email removendo espaços e caixa alta', () => {
    const r = credentialsSchema.parse({
      email: '  User@Exemplo.COM ',
      password: 'senha-forte-123',
    })
    expect(r.email).toBe('user@exemplo.com')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/auth/validation.test.ts`
Expected: FAIL — módulo não encontrado

- [ ] **Step 3: Implementar o helper de sessão e as actions**

```ts
// src/lib/auth/require-user.ts
import 'server-only'
import { createServerSupabase } from '@/lib/supabase/server'

export class UnauthenticatedError extends Error {
  constructor() {
    super('Sessão ausente ou inválida.')
    this.name = 'UnauthenticatedError'
  }
}

/**
 * Fonte única de identidade no servidor. Usa getClaims(), que valida a
 * assinatura do JWT contra as chaves públicas do projeto.
 */
export async function requireUser(): Promise<{ id: string; email: string }> {
  const supabase = await createServerSupabase()
  const { data, error } = await supabase.auth.getClaims()
  const claims = data?.claims
  if (error || !claims?.sub) throw new UnauthenticatedError()
  return { id: claims.sub as string, email: (claims.email as string) ?? '' }
}
```

```ts
// src/app/(auth)/login/schema.ts
import { z } from 'zod'

export const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('Informe um email válido.')),
  password: z.string().min(8, 'A senha precisa ter ao menos 8 caracteres.'),
})

export type AuthState = { error: string | null }
```

```ts
// src/app/(auth)/login/actions.ts
'use server'

import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/lib/supabase/server'
import { credentialsSchema, type AuthState } from './schema'

function parse(formData: FormData) {
  return credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })
}

export async function signIn(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = parse(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  if (error) {
    // Mensagem genérica de propósito: não revela se o email existe.
    return { error: 'Email ou senha inválidos.' }
  }

  redirect('/dashboard')
}

export async function signUp(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = parse(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.signUp(parsed.data)
  if (error) {
    return { error: 'Não foi possível criar a conta. Tente novamente.' }
  }

  redirect('/dashboard')
}
```

```ts
// src/app/auth/signout/route.ts
import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { getCoreEnv } from '@/lib/config/env'

export async function POST() {
  const supabase = await createServerSupabase()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', getCoreEnv().APP_URL), {
    status: 303,
  })
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/auth/validation.test.ts`
Expected: PASS (4 testes)

- [ ] **Step 5: Escrever a página de login**

```tsx
// src/app/(auth)/login/page.tsx
'use client'

import { useActionState } from 'react'
import { signIn, signUp } from './actions'
import type { AuthState } from './schema'

const initial: AuthState = { error: null }

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, initial)
  const [signUpState, signUpAction, signUpPending] = useActionState(
    signUp,
    initial,
  )
  const error = state.error ?? signUpState.error

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
          Reddit Scheduler
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Entre para acessar o painel.
        </p>

        <form className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
            >
              Senha
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              formAction={action}
              disabled={pending || signUpPending}
              className="flex-1 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {pending ? 'Entrando…' : 'Entrar'}
            </button>
            <button
              formAction={signUpAction}
              disabled={pending || signUpPending}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
            >
              Criar conta
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
```

- [ ] **Step 6: Testar o fluxo real no navegador**

```powershell
npm run dev
```

1. Acesse `/dashboard` → deve redirecionar para `/login`.
2. Crie uma conta → deve redirecionar para `/dashboard` (ainda 404, chega na Task 8).
3. Confirme no banco que o profile nasceu:

```powershell
npx supabase db query "select id, timezone from public.profiles"
```

Esperado: uma linha com `America/Sao_Paulo`. Se o comando não existir nesta versão do CLI, use o Studio local em `http://127.0.0.1:54323`.

- [ ] **Step 7: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: login, cadastro e logout com validacao Zod"
```

---

### Task 8: Layout do painel com sidebar

**Files:**
- Create: `src/app/(dashboard)/layout.tsx`
- Create: `src/app/(dashboard)/dashboard/page.tsx`
- Create: `src/components/nav/sidebar.tsx`
- Create: `src/components/nav/nav-items.ts`
- Modify: `src/app/page.tsx`
- Test: `tests/nav/nav-items.test.ts`

**Interfaces:**
- Consumes: `requireUser()` da Task 7
- Produces: `NAV_ITEMS: readonly NavItem[]` onde `NavItem = { href: string; label: string; icon: LucideIcon }`

As dez entradas do menu existem desde já, mesmo apontando para páginas que chegam nos planos seguintes — isso trava a estrutura de navegação da spec e evita retrabalho de layout. São as nove seções da seção 14 da spec mais **Revisão**, a página exigida pelo estado `needs_review`.

- [ ] **Step 1: Instalar os ícones**

```powershell
npm install lucide-react
```

- [ ] **Step 2: Escrever o teste falhando**

```ts
// tests/nav/nav-items.test.ts
import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from '@/components/nav/nav-items'

describe('NAV_ITEMS', () => {
  it('cobre as dez seções de navegação', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Dashboard',
      'Nova publicação',
      'Calendário',
      'Fila',
      'Revisão',
      'Histórico',
      'Contas Reddit',
      'Comunidades',
      'Logs',
      'Configurações',
    ])
  })

  it('todas as rotas ficam sob /dashboard', () => {
    expect(NAV_ITEMS.every((i) => i.href.startsWith('/dashboard'))).toBe(true)
  })

  it('não repete hrefs', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/nav/nav-items.test.ts`
Expected: FAIL — módulo não encontrado

- [ ] **Step 4: Implementar a navegação e o layout**

```ts
// src/components/nav/nav-items.ts
import {
  CalendarDays,
  FileClock,
  Gauge,
  History,
  ListOrdered,
  PlusCircle,
  Radio,
  ScrollText,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = { href: string; label: string; icon: LucideIcon }

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: Gauge },
  { href: '/dashboard/new', label: 'Nova publicação', icon: PlusCircle },
  { href: '/dashboard/calendar', label: 'Calendário', icon: CalendarDays },
  { href: '/dashboard/queue', label: 'Fila', icon: ListOrdered },
  { href: '/dashboard/review', label: 'Revisão', icon: ShieldAlert },
  { href: '/dashboard/history', label: 'Histórico', icon: History },
  { href: '/dashboard/accounts', label: 'Contas Reddit', icon: Radio },
  { href: '/dashboard/communities', label: 'Comunidades', icon: FileClock },
  { href: '/dashboard/logs', label: 'Logs', icon: ScrollText },
  { href: '/dashboard/settings', label: 'Configurações', icon: Settings },
] as const
```

```tsx
// src/components/nav/sidebar.tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_ITEMS } from './nav-items'

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname()

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="px-4 py-5">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
          Reddit Scheduler
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 px-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            href === '/dashboard'
              ? pathname === href
              : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                active
                  ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50'
                  : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800/50'
              }`}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        <p className="truncate px-1 text-xs text-neutral-500" title={email}>
          {email}
        </p>
        <form action="/auth/signout" method="post">
          <button className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Sair
          </button>
        </form>
      </div>
    </aside>
  )
}
```

```tsx
// src/app/(dashboard)/layout.tsx
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/nav/sidebar'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let user: { id: string; email: string }
  try {
    user = await requireUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) redirect('/login')
    throw e
  }

  return (
    <div className="flex min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <Sidebar email={user.email} />
      <main className="flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  )
}
```

```tsx
// src/app/(dashboard)/dashboard/page.tsx
export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Dashboard
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Os indicadores e as próximas publicações chegam no Plano 5.
      </p>
    </div>
  )
}
```

```tsx
// src/app/page.tsx
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/dashboard')
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/nav/nav-items.test.ts`
Expected: PASS (3 testes)

- [ ] **Step 6: Conferir o fluxo completo no navegador**

```powershell
npm run dev
```

1. Deslogado, `/` redireciona para `/login`.
2. Após entrar, `/` cai em `/dashboard` com a sidebar e o email no rodapé.
3. O botão **Sair** volta para `/login`, e `/dashboard` volta a redirecionar.

Este é o critério de aceitação do plano: login, proteção de rota e logout funcionando de ponta a ponta.

- [ ] **Step 7: Verificar e commitar**

Run: `npm run verify`

```bash
git add -A
git commit -m "feat: layout do painel com sidebar e rota protegida"
```

---

### Task 9: README, política de dependências e CI

**Files:**
- Create: `README.md`
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/verify.yml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: os scripts npm da Task 1
- Produces: documentação da Fase -1 e o portão automatizado de verificação

- [ ] **Step 1: Escrever o README**

````markdown
# Reddit Post Scheduler

Painel privado para agendar e publicar automaticamente no Reddit, usando
exclusivamente a API e o OAuth oficiais.

Design: `docs/superpowers/specs/2026-08-16-reddit-post-scheduler-design.md`

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

`npm audit` cobre apenas vulnerabilidades já publicadas em advisory. É um piso
de segurança, não prova de ausência de vulnerabilidades.

## Estado atual

Plano 1 concluído: autenticação do painel, banco com RLS, criptografia e
sanitização de logs. As demais funcionalidades chegam nos Planos 2 a 5.
````

- [ ] **Step 2: Configurar o Dependabot**

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    groups:
      dev-dependencies:
        dependency-type: development
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 3: Configurar o CI**

```yaml
# .github/workflows/verify.yml
name: verify

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test -- --exclude "tests/db/**"
      - run: npm run audit
```

Os testes de banco ficam fora do CI porque dependem do stack local do Supabase;
eles rodam na máquina do desenvolvedor via `npm run test`.

- [ ] **Step 4: Confirmar que o lockfile está versionado**

```powershell
git check-ignore -v package-lock.json
```

Expected: nenhuma saída (o arquivo **não** é ignorado). Se aparecer alguma
regra, remova-a do `.gitignore` — o lockfile é obrigatório pela política de
dependências da spec.

- [ ] **Step 5: Rodar a verificação final do plano**

Run: `npm run verify`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: README com fase -1, dependabot e CI de verificacao"
```

---

## Critério de aceitação do Plano 1

- [ ] `npm run verify` passa do zero num clone limpo (após `npm install` e `.env.local` preenchido)
- [ ] `/dashboard` redireciona para `/login` quando deslogado
- [ ] Criar conta gera automaticamente a linha em `profiles` com timezone `America/Sao_Paulo`
- [ ] Usuário A não lê nem altera o profile do usuário B (provado por teste de integração)
- [ ] `npx supabase db advisors --local` não reporta RLS desabilitada nem `search_path` mutável
- [ ] Nenhum segredo aparece em log: a suíte de sanitização cobre token, refresh token, client secret, senha de proxy, header `Authorization`, cookie e URL de proxy com credenciais
- [ ] `SUPABASE_SECRET_KEY` não aparece em nenhum arquivo com prefixo `NEXT_PUBLIC_`

## Desvio consciente da spec

A Fase 0 da spec lista "projeto Supabase" entre os entregáveis. Este plano cria
apenas o **stack local** (Docker), não o projeto remoto `reddit-scheduler`.

Motivo: todo o desenvolvimento e todos os testes de integração rodam contra o
Postgres local, e criar o projeto remoto agora significaria manter duas bases
sincronizadas por quatro planos sem nenhum ganho. O projeto remoto é criado no
momento do deploy (Plano 5), quando as migrations já estarão estáveis — e essa
criação **exige confirmação de custo do usuário** antes de ser executada.

## O que vem no Plano 2

Fase 2 da spec: OAuth do Reddit com `state` de uso único, tabelas de contas e
segredos, `RedditClientFactory`, refresh automático, configuração de rede por
conta e a verificação empírica de `http`/`https`/`socks5` contra a versão
instalada do `undici`.
