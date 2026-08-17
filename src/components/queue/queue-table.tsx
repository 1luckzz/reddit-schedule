'use client'

import { useActionState, useState } from 'react'
import {
  cancelPost,
  reschedulePost,
  type QueueState,
} from '@/app/(dashboard)/dashboard/queue/actions'
import { StatusChip } from '@/components/ui/status-chip'
import {
  botaoPrimario,
  cabecalhoTabela,
  campo,
  modulo,
  rotuloCampo,
} from '@/components/ui/estilo'
import { podeEditar } from '@/lib/scheduling/status'
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
      <p className="mt-8 text-sm text-fosforo-dim">
        Nenhuma publicação corresponde a estes filtros.
      </p>
    )
  }

  return (
    <div className={`${modulo} mt-4 overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead className={cabecalhoTabela}>
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
      <tr className="border-b border-risco/60 transition-colors last:border-0 hover:bg-console-2/50">
        <td className="whitespace-nowrap px-3 py-2">
          <span className="font-mono text-[13px] tabular-nums text-ambar">
            {local.time}
          </span>{' '}
          <span className="font-mono text-[11px] tabular-nums text-fosforo-dim">
            {local.date}
          </span>
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-xs text-fosforo-dim">
          u/{item.reddit_accounts?.username ?? '—'} → r/
          {item.subreddits?.name ?? '—'}
        </td>
        <td className="max-w-xs truncate px-3 py-2 text-fosforo">
          {item.title}
        </td>
        <td className="whitespace-nowrap px-3 py-2">
          <StatusChip status={item.status} />
          {item.retry_count > 0 && (
            <span className="ml-1.5 font-mono text-[11px] text-fosforo-dim">
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
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setAberto((v) => !v)}
                className="text-xs text-standby underline transition-colors hover:text-fosforo"
              >
                Reagendar
              </button>
              <form action={cancelar}>
                <input type="hidden" name="postId" value={item.id} />
                <button
                  type="submit"
                  disabled={cancelando}
                  className="text-xs text-tijolo underline transition-colors hover:text-noar disabled:opacity-60"
                >
                  Cancelar
                </button>
              </form>
            </div>
          ) : (
            <span className="text-xs text-fosforo-dim/60">—</span>
          )}
        </td>
      </tr>

      {(estadoCancelar.error || estadoReagendar.error) && (
        <tr>
          <td colSpan={5} className="px-3 pb-2">
            <p className="text-xs text-tijolo" role="alert">
              {estadoCancelar.error ?? estadoReagendar.error}
            </p>
          </td>
        </tr>
      )}

      {aberto && editavel && (
        <tr className="border-b border-risco/60">
          <td colSpan={5} className="bg-console-2 px-3 py-3">
            <form action={reagendar} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="postId" value={item.id} />
              <label className={rotuloCampo}>
                Data
                <input
                  type="date"
                  name="date"
                  required
                  defaultValue={local.date}
                  className={campo}
                />
              </label>
              <label className={rotuloCampo}>
                Hora
                <input
                  type="time"
                  name="time"
                  required
                  defaultValue={local.time}
                  className={campo}
                />
              </label>
              <label className={rotuloCampo}>
                Fuso
                <select
                  name="timeZone"
                  defaultValue={item.timezone}
                  className={campo}
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
              <label className={rotuloCampo}>
                Ocorrência
                <select name="occurrence" defaultValue="" className={campo}>
                  <option value="">Automática</option>
                  <option value="0">Primeira</option>
                  <option value="1">Segunda</option>
                </select>
              </label>
              <button
                type="submit"
                disabled={reagendando}
                className={botaoPrimario}
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
