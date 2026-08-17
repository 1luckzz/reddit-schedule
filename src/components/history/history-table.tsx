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
  reddit_accounts: { username: string } | null
  subreddits: { name: string } | null
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
      <p className="mt-8 text-sm text-fosforo-dim">
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
            <th className="px-3 py-2 font-medium">Planejado</th>
            <th className="px-3 py-2 font-medium">Real</th>
            <th className="px-3 py-2 font-medium">Conta → Comunidade</th>
            <th className="px-3 py-2 font-medium">Título</th>
            <th className="px-3 py-2 font-medium">Situação</th>
            <th className="px-3 py-2 font-medium">Publicação</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((item) => (
            <tr
              key={item.id}
              className="border-b border-risco/60 align-top transition-colors last:border-0 hover:bg-console-2/50"
            >
              {/*
                Planejado apagado, Real aceso: a diferença entre os dois é a
                informação de operação — atraso de fila, retentativa, resolução
                manual — e o olho compara as duas colunas mono em sequência.
              */}
              <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] tabular-nums text-fosforo-dim">
                {local(item.scheduled_at)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] tabular-nums text-fosforo">
                {local(item.published_at) ?? '—'}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs text-fosforo-dim">
                u/{item.reddit_accounts?.username ?? '—'} → r/
                {item.subreddits?.name ?? '—'}
              </td>
              <td className="max-w-xs px-3 py-2 text-fosforo">
                <span className="block truncate">{item.title}</span>
                {/*
                  A mensagem já vem em português e sem jargão: é a `userMessage`
                  do erro classificado, não o código interno.
                */}
                {item.error_message && (
                  <span className="mt-0.5 block text-xs text-tijolo">
                    {item.error_message}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                <StatusChip status={item.status} />
                {item.resolved_at && (
                  <span
                    className="ml-1.5 text-xs text-fosforo-dim"
                    title={`Decisão registrada em ${local(item.resolved_at)}`}
                  >
                    resolvido manualmente
                  </span>
                )}
                {item.retry_count > 0 && (
                  <span className="ml-1.5 font-mono text-[11px] text-fosforo-dim">
                    {item.retry_count} tentativa(s)
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {item.reddit_permalink ? (
                  <a
                    href={item.reddit_permalink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-xs text-ambar underline transition-colors hover:text-fosforo"
                  >
                    Abrir no Reddit
                  </a>
                ) : (
                  <span className="font-mono text-[11px] text-fosforo-dim/60">
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
