// Nada aqui lê a chave secreta: o client chega como parâmetro. É o que mantém
// todo o `src/lib/worker/` livre de segredos e importável de qualquer lado.
import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitize } from '@/lib/logging/sanitize'

const MAX_MESSAGE = 2000

export type ExecutionLogEntry = {
  ownerId: string
  action: string
  outcome: 'success' | 'failure' | 'retry' | 'unknown'
  redditAccountId?: string | null
  scheduledPostId?: string | null
  scheduledCommentId?: string | null
  httpStatus?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  durationMs?: number | null
}

/**
 * Grava uma linha em execution_logs.
 *
 * A mensagem passa por `sanitize` antes de sair daqui — nenhum token, senha de
 * proxy, header Authorization ou URL com credenciais chega ao banco.
 *
 * Falhas são engolidas de propósito: log é telemetria e não pode custar a
 * operação do usuário.
 */
export async function logExecution(
  service: SupabaseClient,
  entry: ExecutionLogEntry,
): Promise<void> {
  try {
    const mensagem = entry.errorMessage
      ? String(sanitize(entry.errorMessage)).slice(0, MAX_MESSAGE)
      : null

    await service.from('execution_logs').insert({
      owner_id: entry.ownerId,
      reddit_account_id: entry.redditAccountId ?? null,
      scheduled_post_id: entry.scheduledPostId ?? null,
      scheduled_comment_id: entry.scheduledCommentId ?? null,
      action: entry.action,
      outcome: entry.outcome,
      http_status: entry.httpStatus ?? null,
      error_code: entry.errorCode ?? null,
      error_message: mensagem,
      duration_ms: entry.durationMs ?? null,
    })
  } catch {
    // Silenciado de propósito: ver JSDoc.
  }
}
