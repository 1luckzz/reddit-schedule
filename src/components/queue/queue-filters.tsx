'use client'

import { botaoPrimario, campo, rotuloCampo } from '@/components/ui/estilo'
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
  return (
    <form
      method="get"
      action={action}
      className="mt-6 flex flex-wrap items-end gap-3"
    >
      <label className={rotuloCampo}>
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

      <label className={rotuloCampo}>
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

      <label className={rotuloCampo}>
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

      <label className={rotuloCampo}>
        De
        <input
          type="date"
          name="from"
          defaultValue={atual.from ?? ''}
          className={campo}
        />
      </label>

      <label className={rotuloCampo}>
        Até
        <input
          type="date"
          name="to"
          defaultValue={atual.to ?? ''}
          className={campo}
        />
      </label>

      <label className={rotuloCampo}>
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

      <button type="submit" className={botaoPrimario}>
        Filtrar
      </button>
      <a
        href={action}
        className="px-2 py-2 text-sm text-fraco transition-colors duration-150 hover:text-claro"
      >
        Limpar
      </a>
    </form>
  )
}
