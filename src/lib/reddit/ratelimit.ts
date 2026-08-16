import type { RateLimitSnapshot } from './types'

function num(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Os headers X-Ratelimit-* são a fonte operacional de verdade sobre o
 * orçamento de requisições — mais confiável que qualquer limite documentado.
 */
export function readRateLimit(
  headers: Record<string, unknown>,
): RateLimitSnapshot {
  return {
    used: num(headers['x-ratelimit-used']),
    remaining: num(headers['x-ratelimit-remaining']),
    resetSeconds: num(headers['x-ratelimit-reset']),
  }
}
