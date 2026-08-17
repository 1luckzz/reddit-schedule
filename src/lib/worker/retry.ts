/** Depois disso, o job é marcado como falho em vez de insistir. */
export const MAX_RETRIES = 3

const BACKOFF_SECONDS = [60, 300, 1500]

/**
 * Momento da próxima tentativa.
 *
 * `Retry-After` do Reddit só é considerado quando é MAIOR que o backoff: ele
 * pode encurtar a espera que nós mesmos impusemos, e insistir mais cedo do que
 * o combinado seria justamente o comportamento abusivo que a spec proíbe.
 */
export function nextAttemptAt(
  retryCount: number,
  retryAfterSeconds?: number,
): Date {
  const indice = Math.min(retryCount, BACKOFF_SECONDS.length - 1)
  const base = BACKOFF_SECONDS[indice]
  const segundos = Math.max(base, retryAfterSeconds ?? 0)
  return new Date(Date.now() + segundos * 1000)
}
