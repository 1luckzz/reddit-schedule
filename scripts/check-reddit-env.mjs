/**
 * Pré-checagem do ambiente antes do teste end-to-end do OAuth.
 *
 * Nunca imprime valores de credenciais — apenas presença, formato e
 * consistência. Rode com: npm run check:reddit
 */
import { existsSync } from 'node:fs'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')

const problemas = []
const avisos = []

function ok(nome, detalhe = '') {
  console.log(`OK    ${nome}${detalhe ? ` — ${detalhe}` : ''}`)
}
function falha(nome, comoResolver) {
  console.log(`FALHA ${nome}`)
  problemas.push(`${nome}\n      → ${comoResolver}`)
}
function aviso(nome, detalhe) {
  console.log(`AVISO ${nome} — ${detalhe}`)
  avisos.push(nome)
}

const clientId = process.env.REDDIT_CLIENT_ID ?? ''
const clientSecret = process.env.REDDIT_CLIENT_SECRET ?? ''
const redirect = process.env.REDDIT_REDIRECT_URI ?? ''
const userAgent = process.env.REDDIT_USER_AGENT ?? ''
const appUrl = process.env.APP_URL ?? ''

// --- credenciais: só presença e comprimento plausível ---
if (!clientId) {
  falha(
    'REDDIT_CLIENT_ID definido',
    'copie o identificador que aparece logo abaixo do nome do app em /prefs/apps',
  )
} else if (clientId.length < 10) {
  aviso('REDDIT_CLIENT_ID', `tem só ${clientId.length} caracteres, parece curto`)
} else {
  ok('REDDIT_CLIENT_ID definido', `${clientId.length} caracteres`)
}

if (!clientSecret) {
  falha(
    'REDDIT_CLIENT_SECRET definido',
    'campo "secret" do app em /prefs/apps',
  )
} else if (clientSecret.length < 20) {
  aviso(
    'REDDIT_CLIENT_SECRET',
    `tem só ${clientSecret.length} caracteres, parece curto`,
  )
} else {
  ok('REDDIT_CLIENT_SECRET definido', `${clientSecret.length} caracteres`)
}

if (clientId && clientSecret && clientId === clientSecret) {
  falha(
    'CLIENT_ID e CLIENT_SECRET são diferentes',
    'os dois campos estão com o mesmo valor — confira qual é qual em /prefs/apps',
  )
}

// --- redirect uri ---
if (!redirect) {
  falha('REDDIT_REDIRECT_URI definido', 'deve ser <APP_URL>/api/reddit/callback')
} else {
  const esperado = `${appUrl.replace(/\/$/, '')}/api/reddit/callback`
  if (redirect !== esperado) {
    falha(
      'REDDIT_REDIRECT_URI bate com APP_URL',
      `esperado "${esperado}", encontrado "${redirect}"`,
    )
  } else {
    ok('REDDIT_REDIRECT_URI consistente com APP_URL', redirect)
  }
}

// --- user agent ---
if (!userAgent) {
  falha('REDDIT_USER_AGENT definido', 'formato web:<app>:<versao> (by /u/<voce>)')
} else if (userAgent.includes('SEU_USUARIO')) {
  falha(
    'REDDIT_USER_AGENT personalizado',
    'troque SEU_USUARIO pelo seu usuário do Reddit',
  )
} else if (!/^web:[^:]+:[^ ]+ \(by \/u\/.+\)$/.test(userAgent)) {
  aviso(
    'REDDIT_USER_AGENT',
    'fora do formato recomendado web:<app>:<versao> (by /u/<voce>)',
  )
} else {
  ok('REDDIT_USER_AGENT no formato esperado')
}

// --- validação pelo próprio schema da aplicação ---
try {
  const { getRedditEnv } = await import('../src/lib/config/env.ts')
  getRedditEnv()
  ok('schema Zod da aplicação aceita o ambiente')
} catch (e) {
  // A mensagem do EnvError lista nomes de variáveis, nunca valores.
  falha('schema Zod da aplicação', String(e.message).replace(/\n/g, '\n      '))
}

// --- servidor de desenvolvimento ---
try {
  const res = await fetch(`${appUrl}/login`, {
    signal: AbortSignal.timeout(3000),
    redirect: 'manual',
  })
  ok('servidor de desenvolvimento respondendo', `${appUrl} (${res.status})`)
} catch {
  aviso(
    'servidor de desenvolvimento',
    `não respondeu em ${appUrl} — rode "npm run dev" antes do teste`,
  )
}

console.log('')
if (problemas.length) {
  console.log('Pendências antes do teste end-to-end:\n')
  problemas.forEach((p, i) => console.log(`  ${i + 1}. ${p}`))
  console.log('')
  process.exit(1)
}

console.log('Ambiente pronto para o teste end-to-end do OAuth.')
if (avisos.length) console.log(`(${avisos.length} aviso(s) não bloqueante(s))`)
