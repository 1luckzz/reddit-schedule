import { StatusChip } from '@/components/ui/status-chip'
import { cabecalhoTabela, modulo } from '@/components/ui/estilo'
import { fromUtc } from '@/lib/scheduling/timezone'

export type HistoryRow = {
  id: string
  title: string
  status: string
  scheduled_at: string
  timezone: string
  published_at: string | null
  reddit_post_id: string | null
  reddit_permalink: string | null
  error_message: string | null
  retry_count: number
  resolved_by: string | null
  resolved_at: string | null
  publisher: string | null
  reddit_accounts: { username: string } | null
  subreddits: { name: string } | null
  devvit_installations: { subreddit_name: string } | null
  scheduled_comments: { status: string }[] | null
}

/**
 * Server Component: a tabela é só leitura, sem nenhuma ação.
 *
 * Sem `'use client'` de propósito — nada aqui precisa de estado, e manter a
 * renderização no servidor evita mandar dados para o navegador sem motivo.
 */
export function HistoryTable({
  itens,
  timeZone,
}: {
  itens: readonly HistoryRow[]
  timeZone: string
}) {
  if (itens.length === 0) {
    return (
      <p className="mt-8 text-sm text-medio">
        Nenhuma publicação concluída corresponde a estes filtros.
      </p>
    )
  }

  const local = (iso: string | null) => {
    if (!iso) return null
    const { date, time } = fromUtc(new Date(iso), timeZone)
    return `${date} ${time}`
  }

  return (
    <div className={`${modulo} mt-4 overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead className={cabecalhoTabela}>
          <tr>
            <th className="px-4 py-2.5 font-medium">Planejado</th>
            <th className="px-4 py-2.5 font-medium">Real</th>
            <th className="px-4 py-2.5 font-medium">Conta → Comunidade</th>
            <th className="px-4 py-2.5 font-medium">Título</th>
            <th className="px-4 py-2.5 font-medium">Situação</th>
            <th className="px-4 py-2.5 font-medium">Publicação</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((item) => (
            <tr
              key={item.id}
              className="border-b border-white/5 align-top transition-colors last:border-0 hover:bg-white/[0.03]"
            >
              {/*
                Planejado apagado, Real aceso: a diferença entre os dois é a
                informação de operação — atraso de fila, retentativa, resolução
                manual — e o olho compara as duas colunas tabulares em sequência.
              */}
              <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-fraco">
                {local(item.scheduled_at)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-claro">
                {local(item.published_at) ?? '—'}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-[13px] text-fraco">
                {item.publisher === 'devvit'
                  ? 'App Devvit'
                  : `u/${item.reddit_accounts?.username ?? '—'}`}{' '}
                → r/
                {item.subreddits?.name ??
                  item.devvit_installations?.subreddit_name ??
                  '—'}
              </td>
              <td className="max-w-xs px-4 py-3 text-claro">
                <span className="block truncate">{item.title}</span>
                {/*
                  A mensagem já vem em português e sem jargão: é a `userMessage`
                  do erro classificado, não o código interno.
                */}
                {item.error_message && (
                  <span className="mt-0.5 block text-xs text-rosa/90">
                    {item.error_message}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <StatusChip status={item.status} />
                {item.resolved_at && (
                  <span
                    className="ml-1.5 text-xs text-fraco"
                    title={`Decisão registrada em ${local(item.resolved_at)}`}
                  >
                    resolvido manualmente
                  </span>
                )}
                {item.retry_count > 0 && (
                  <span className="ml-1.5 text-xs tabular-nums text-fraco">
                    {item.retry_count} tentativa(s)
                  </span>
                )}
                {/*
                  A falha do comentário nunca muda o estado do post — o post
                  está publicado de fato. Ela aparece como informação anexa.
                */}
                {item.status === 'published' &&
                  (item.scheduled_comments ?? []).some(
                    (c) => c.status === 'failed',
                  ) && (
                    <span className="ml-1.5 text-xs text-rosa/90">
                      Comentário falhou
                    </span>
                  )}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                {item.reddit_permalink ? (
                  <a
                    href={item.reddit_permalink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-xs text-medio underline underline-offset-2 transition-colors duration-150 hover:text-claro"
                  >
                    Abrir no Reddit
                  </a>
                ) : (
                  <span className="font-mono text-[11px] text-fraco/80">
                    {item.reddit_post_id ?? '—'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
