'use client'

import { POST_STATUSES, rotuloStatus } from '@/lib/scheduling/status'
import { SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

type Conta = { id: string; username: string }
type Comunidade = { id: string; name: string; reddit_account_id: string }

/**
 * Filtros como um formulário GET.
 *
 * Sem estado nem `useState`: o formulário navega para a mesma rota com os
 * parâmetros na URL, e a página os aplica na consulta. Isso mantém o filtro
 * compartilhável por link e recarregável, e evita duplicar a lógica de
 * filtragem entre servidor e cliente.
 */
export function QueueFilters({
  contas,
  comunidades,
  atual,
  action = '/dashboard/queue',
  statusDisponiveis = POST_STATUSES as readonly string[],
}: {
  contas: readonly Conta[]
  comunidades: readonly Comunidade[]
  atual: {
    account?: string
    community?: string
    status?: string
    from?: string
    to?: string
    tz?: string
  }
  action?: string
  statusDisponiveis?: readonly string[]
}) {
  const campo =
    'rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'

  return (
    <form
      method="get"
      action={action}
      className="mt-5 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Conta
        <select name="account" defaultValue={atual.account ?? ''} className={campo}>
          <option value="">Todas</option>
          {contas.map((c) => (
            <option key={c.id} value={c.id}>
              u/{c.username}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Comunidade
        <select
          name="community"
          defaultValue={atual.community ?? ''}
          className={campo}
        >
          <option value="">Todas</option>
          {comunidades.map((c) => (
            <option key={c.id} value={c.id}>
              r/{c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Situação
        <select name="status" defaultValue={atual.status ?? ''} className={campo}>
          <option value="">Todas</option>
          {statusDisponiveis.map((s) => (
            <option key={s} value={s}>
              {rotuloStatus(s)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        De
        <input
          type="date"
          name="from"
          defaultValue={atual.from ?? ''}
          className={campo}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Até
        <input
          type="date"
          name="to"
          defaultValue={atual.to ?? ''}
          className={campo}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
        Fuso de exibição
        <select
          name="tz"
          defaultValue={atual.tz ?? 'America/Sao_Paulo'}
          className={campo}
        >
          {SUPPORTED_TIME_ZONES.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Filtrar
      </button>
      <a
        href={action}
        className="px-2 py-2 text-sm text-neutral-600 underline dark:text-neutral-400"
      >
        Limpar
      </a>
    </form>
  )
}
