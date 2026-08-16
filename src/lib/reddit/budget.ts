import 'server-only'
import { createHash } from 'node:crypto'
import { getRedditEnv } from '@/lib/config/env'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { RedditError } from './errors'
import type { RateLimitSnapshot } from './types'

/**
 * Abaixo deste número de requisições restantes, a aplicação se pausa até o
 * reset. A folga existe para não bater no 429 do Reddit, que é a fronteira
 * real — os headers são aproximados.
 */
export const BUDGET_THRESHOLD = 10

export type Budget = {
  used: number | null
  remaining: number | null
  /** Requisições em voo desde o último snapshot. */
  reserved: number
  resetAt: Date | null
  pausedUntil: Date | null
}

function clientHash(): string {
  return createHash('sha256')
    .update(getRedditEnv().REDDIT_CLIENT_ID)
    .digest('hex')
}

/**
 * Reserva capacidade antes de uma requisição ao Reddit.
 *
 * A atomicidade vive na função SQL: um SELECT ... FOR UPDATE serializa as
 * chamadas concorrentes, de modo que a segunda enxerga a reserva da primeira.
 * Sem isso, duas requisições simultâneas leriam o mesmo `remaining` e
 * reservariam a mesma capacidade.
 *
 * Toda reserva bem-sucedida PRECISA ser devolvida por reconcileBudget, mesmo
 * quando a requisição falha — senão o contador de requisições em voo só sobe.
 */
export async function reserveBudget(): Promise<void> {
  const admin = createAdminSupabase()
  const { data, error } = await admin.rpc('reserve_api_budget', {
    p_client_id_hash: clientHash(),
    p_threshold: BUDGET_THRESHOLD,
  })

  if (error) {
    // Falha ao falar com o orçamento não deve impedir o trabalho: o 429 do
    // Reddit continua sendo a rede de proteção.
    return
  }

  const resultado = Array.isArray(data) ? data[0] : data
  if (!resultado || resultado.allowed) return

  const pausadoAte = resultado.paused_until
    ? new Date(resultado.paused_until as string)
    : null
  const segundos = pausadoAte
    ? Math.max(1, Math.ceil((pausadoAte.getTime() - Date.now()) / 1000))
    : 60

  throw new RedditError({
    code: 'BUDGET_EXHAUSTED',
    disposition: 'retryable',
    retryAfterSeconds: segundos,
    userMessage: `O limite de requisições ao Reddit foi atingido. Aguarde cerca de ${segundos} segundos e tente novamente.`,
  })
}

/**
 * Devolve a reserva e sincroniza o orçamento com os headers da resposta.
 *
 * `null` significa que a requisição não produziu resposta legível: a reserva
 * é liberada sem alterar os números vindos do Reddit.
 */
export async function reconcileBudget(
  snapshot: RateLimitSnapshot | null,
): Promise<void> {
  const admin = createAdminSupabase()
  await admin.rpc('reconcile_api_budget', {
    p_client_id_hash: clientHash(),
    p_used: snapshot?.used ?? null,
    p_remaining: snapshot?.remaining ?? null,
    p_reset_seconds: snapshot?.resetSeconds ?? null,
    p_threshold: BUDGET_THRESHOLD,
  })
}

export async function getBudget(): Promise<Budget | null> {
  const admin = createAdminSupabase()
  const { data } = await admin
    .from('reddit_api_budget')
    .select('used, remaining, reset_at, reserved, paused_until')
    .eq('client_id_hash', clientHash())
    .maybeSingle()

  if (!data) return null

  return {
    used: data.used,
    remaining: data.remaining,
    reserved: data.reserved,
    resetAt: data.reset_at ? new Date(data.reset_at) : null,
    pausedUntil: data.paused_until ? new Date(data.paused_until) : null,
  }
}
