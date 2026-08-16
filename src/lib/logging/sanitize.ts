const REDACTED = '[REDACTED]'

const SENSITIVE_KEY =
  /(access[_-]?token|refresh[_-]?token|client[_-]?secret|proxy[_-]?password|password|authorization|cookie|set[_-]?cookie|encryption[_-]?key|secret[_-]?key|api[_-]?key)/i

// usuario:senha@host  ->  [REDACTED]:[REDACTED]@host
const URL_CREDENTIALS = /([a-z0-9+.-]+:\/\/)[^/\s:@]+:[^/\s@]+@/gi
// bearer <token>
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi

function sanitizeString(value: string): string {
  return value
    .replace(URL_CREDENTIALS, `$1${REDACTED}:${REDACTED}@`)
    .replace(BEARER, `$1 ${REDACTED}`)
}

/**
 * Clona um valor removendo segredos, para uso antes de qualquer escrita em
 * execution_logs ou console. Redige por nome de chave e também por padrão
 * dentro de strings livres, porque segredos vazam nas duas formas.
 */
export function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (value instanceof Error) {
    return { name: value.name, message: sanitizeString(value.message) }
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

/**
 * Mascara um host para exibição. Mesma regra aplicada pelo trigger que
 * mantém `reddit_accounts.proxy_host_masked`.
 */
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
