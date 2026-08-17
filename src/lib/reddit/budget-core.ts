// Sem `server-only`: o worker precisa do mesmo controle de orcamento, e o
// client chega por parametro em vez de ser criado aqui. Ver
// `src/lib/supabase/service-factory.ts` para o porque dessa forma.
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getRedditEnv } from '@/lib/config/env'
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

export function clientHash(): string {
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
 * **Fail-closed.** Se o mecanismo de orçamento estiver indisponível, a chamada
 * externa não acontece: erro de banco vira `BUDGET_UNAVAILABLE` retryable.
 * Isso é diferente de `remaining` desconhecido — ali o mecanismo funcionou e
 * respondeu, apenas ainda não sabemos o saldo. Aqui não sabemos nem se
 * estamos contando.
 *
 * **Bootstrap conservador.** Enquanto o saldo é desconhecido, apenas UMA
 * requisição fica em voo por client_id: a primeira sai normalmente e seus
 * headers revelam o limite; as concorrentes recebem `BUDGET_BOOTSTRAP` e
 * tentam de novo em segundos. Quota desconhecida não pode significar
 * concorrência ilimitada.
 *
 * Toda reserva bem-sucedida PRECISA ser devolvida por reconcileBudget, mesmo
 * quando a requisição falha — senão o contador de requisições em voo só sobe.
 */
function budgetUnavailable(): RedditError {
  return new RedditError({
    code: 'BUDGET_UNAVAILABLE',
    disposition: 'retryable',
    retryAfterSeconds: 30,
    userMessage:
      'Não foi possível verificar o limite de requisições ao Reddit agora. Tente novamente em instantes.',
  })
}

export async function reserveBudgetWith(admin: SupabaseClient): Promise<void> {

  let data: unknown
  let error: unknown

  try {
    ;({ data, error } = await admin.rpc('reserve_api_budget', {
      p_client_id_hash: clientHash(),
      p_threshold: BUDGET_THRESHOLD,
    }))
  } catch {
    // Fail-closed: sem conseguir reservar, não emitimos a requisição externa.
    // Deixar passar transformaria uma falha do nosso controle em tráfego não
    // contabilizado contra o limite do Reddit.
    throw budgetUnavailable()
  }

  if (error) throw budgetUnavailable()

  const resultado = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; paused_until: string | null; reason?: string }
    | undefined

  // Resposta inesperada é indisponibilidade, não permissão.
  if (!resultado) throw budgetUnavailable()

  if (resultado.allowed) return

  // Ainda descobrindo o limite: uma requisição já está em voo e vai revelar o
  // saldo real. Esperar poucos segundos costuma bastar.
  if (resultado.reason === 'bootstrap') {
    throw new RedditError({
      code: 'BUDGET_BOOTSTRAP',
      disposition: 'retryable',
      retryAfterSeconds: 5,
      userMessage:
        'Verificando o limite de requisições ao Reddit. Tente novamente em alguns segundos.',
    })
  }

  const pausadoAte = resultado.paused_until
    ? new Date(resultado.paused_until)
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
export async function reconcileBudgetWith(
  admin: SupabaseClient,
  snapshot: RateLimitSnapshot | null,
): Promise<void> {
  await admin.rpc('reconcile_api_budget', {
    p_client_id_hash: clientHash(),
    p_used: snapshot?.used ?? null,
    p_remaining: snapshot?.remaining ?? null,
    p_reset_seconds: snapshot?.resetSeconds ?? null,
    p_threshold: BUDGET_THRESHOLD,
  })
}

export async function getBudgetWith(admin: SupabaseClient): Promise<Budget | null> {
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
