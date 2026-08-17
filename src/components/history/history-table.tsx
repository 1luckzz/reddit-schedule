import { corStatus, rotuloStatus } from '@/lib/scheduling/status'
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
      <p className="mt-8 text-sm text-neutral-500">
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
    <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <table className="w-full text-sm">
        <thead className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
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
              className="border-b border-neutral-100 last:border-0 align-top dark:border-neutral-800/60"
            >
              <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-400">
                {local(item.scheduled_at)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-neutral-700 dark:text-neutral-300">
                {local(item.published_at) ?? '—'}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-400">
                u/{item.reddit_accounts?.username ?? '—'} → r/
                {item.subreddits?.name ?? '—'}
              </td>
              <td className="max-w-xs px-3 py-2 text-neutral-900 dark:text-neutral-50">
                <span className="block truncate">{item.title}</span>
                {/*
                  A mensagem já vem em português e sem jargão: é a `userMessage`
                  do erro classificado, não o código interno.
                */}
                {item.error_message && (
                  <span className="mt-0.5 block text-xs text-red-600 dark:text-red-400">
                    {item.error_message}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${corStatus(item.status)}`}
                >
                  {rotuloStatus(item.status)}
                </span>
                {item.resolved_at && (
                  <span
                    className="ml-1.5 text-xs text-neutral-500"
                    title={`Decisão registrada em ${local(item.resolved_at)}`}
                  >
                    resolvido manualmente
                  </span>
                )}
                {item.retry_count > 0 && (
                  <span className="ml-1.5 text-xs text-neutral-500">
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
                    className="text-xs text-blue-600 underline dark:text-blue-400"
                  >
                    Abrir no Reddit
                  </a>
                ) : (
                  <span className="text-xs text-neutral-400">
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
