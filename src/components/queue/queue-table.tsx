'use client'

import { useActionState, useState } from 'react'
import {
  cancelPost,
  reschedulePost,
  type QueueState,
} from '@/app/(dashboard)/dashboard/queue/actions'
import { corStatus, podeEditar, rotuloStatus } from '@/lib/scheduling/status'
import { fromUtc, SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

export type QueueRow = {
  id: string
  title: string
  status: string
  scheduled_at: string
  timezone: string
  post_kind: string
  url: string | null
  error_message: string | null
  retry_count: number
  next_attempt_at: string | null
  reddit_accounts: { username: string } | null
  subreddits: { name: string } | null
}

const inicial: QueueState = { error: null, ok: false }

export function QueueTable({
  itens,
  timeZone,
}: {
  itens: readonly QueueRow[]
  timeZone: string
}) {
  if (itens.length === 0) {
    return (
      <p className="mt-8 text-sm text-neutral-500">
        Nenhuma publicação corresponde a estes filtros.
      </p>
    )
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <table className="w-full text-sm">
        <thead className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
          <tr>
            <th className="px-3 py-2 font-medium">Quando</th>
            <th className="px-3 py-2 font-medium">Conta → Comunidade</th>
            <th className="px-3 py-2 font-medium">Título</th>
            <th className="px-3 py-2 font-medium">Situação</th>
            <th className="px-3 py-2 font-medium">Ações</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((item) => (
            <QueueLinha key={item.id} item={item} timeZone={timeZone} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function QueueLinha({
  item,
  timeZone,
}: {
  item: QueueRow
  timeZone: string
}) {
  const [aberto, setAberto] = useState(false)
  const [estadoCancelar, cancelar, cancelando] = useActionState(
    cancelPost,
    inicial,
  )
  const [estadoReagendar, reagendar, reagendando] = useActionState(
    reschedulePost,
    inicial,
  )

  const local = fromUtc(new Date(item.scheduled_at), timeZone)
  const editavel = podeEditar(item.status)

  return (
    <>
      <tr className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
        <td className="whitespace-nowrap px-3 py-2 text-neutral-700 dark:text-neutral-300">
          {local.date} {local.time}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-400">
          u/{item.reddit_accounts?.username ?? '—'} → r/
          {item.subreddits?.name ?? '—'}
        </td>
        <td className="max-w-xs truncate px-3 py-2 text-neutral-900 dark:text-neutral-50">
          {item.title}
        </td>
        <td className="whitespace-nowrap px-3 py-2">
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${corStatus(item.status)}`}
          >
            {rotuloStatus(item.status)}
          </span>
          {item.retry_count > 0 && (
            <span className="ml-1.5 text-xs text-neutral-500">
              {item.retry_count} tentativa(s)
            </span>
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-2">
          {/*
            Reagendar e cancelar aparecem apenas em draft e scheduled — a mesma
            regra que o trigger e a RPC já impõem. A interface não é a barreira;
            ela só evita oferecer o que seria recusado.
          */}
          {editavel ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAberto((v) => !v)}
                className="text-xs text-blue-600 underline dark:text-blue-400"
              >
                Reagendar
              </button>
              <form action={cancelar}>
                <input type="hidden" name="postId" value={item.id} />
                <button
                  type="submit"
                  disabled={cancelando}
                  className="text-xs text-red-600 underline disabled:opacity-60 dark:text-red-400"
                >
                  Cancelar
                </button>
              </form>
            </div>
          ) : (
            <span className="text-xs text-neutral-400">—</span>
          )}
        </td>
      </tr>

      {(estadoCancelar.error || estadoReagendar.error) && (
        <tr>
          <td colSpan={5} className="px-3 pb-2">
            <p className="text-xs text-red-600 dark:text-red-400" role="alert">
              {estadoCancelar.error ?? estadoReagendar.error}
            </p>
          </td>
        </tr>
      )}

      {aberto && editavel && (
        <tr className="border-b border-neutral-100 dark:border-neutral-800/60">
          <td colSpan={5} className="bg-neutral-50 px-3 py-3 dark:bg-neutral-950/40">
            <form action={reagendar} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="postId" value={item.id} />
              <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                Data
                <input
                  type="date"
                  name="date"
                  required
                  defaultValue={local.date}
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                Hora
                <input
                  type="time"
                  name="time"
                  required
                  defaultValue={local.time}
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                Fuso
                <select
                  name="timeZone"
                  defaultValue={item.timezone}
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {SUPPORTED_TIME_ZONES.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </label>
              {/*
                Preenchido apenas quando o horário ocorre duas vezes por causa
                do fim do horário de verão — a action devolve a mensagem
                pedindo a escolha, com os offsets de cada ocorrência.
              */}
              <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                Ocorrência
                <select
                  name="occurrence"
                  defaultValue=""
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <option value="">Automática</option>
                  <option value="0">Primeira</option>
                  <option value="1">Segunda</option>
                </select>
              </label>
              <button
                type="submit"
                disabled={reagendando}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-neutral-50 dark:text-neutral-900"
              >
                Salvar
              </button>
            </form>
          </td>
        </tr>
      )}
    </>
  )
}
