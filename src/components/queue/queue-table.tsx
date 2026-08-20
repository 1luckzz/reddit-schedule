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
import { podeEditar, rotuloDevvit } from '@/lib/scheduling/status'
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
  publisher: string | null
  devvit_sync_status: string | null
  devvit_sync_error: string | null
  reddit_accounts: { username: string } | null
  subreddits: { name: string } | null
  devvit_installations: { subreddit_name: string } | null
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
      <p className="mt-8 text-sm text-medio">
        Nenhuma publicação corresponde a estes filtros.
      </p>
    )
  }

  return (
    <div className={`${modulo} mt-4 overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead className={cabecalhoTabela}>
          <tr>
            <th className="px-4 py-2.5 font-medium">Quando</th>
            <th className="px-4 py-2.5 font-medium">Conta → Comunidade</th>
            <th className="px-4 py-2.5 font-medium">Título</th>
            <th className="px-4 py-2.5 font-medium">Situação</th>
            <th className="px-4 py-2.5 font-medium">Ações</th>
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
      <tr className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.03]">
        <td className="whitespace-nowrap px-4 py-3">
          <span className="tabular-nums text-claro">{local.time}</span>{' '}
          <span className="text-[13px] tabular-nums text-fraco">
            {local.date}
          </span>
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-xs text-medio">
          {/* No caminho Devvit a identidade que publica é o app, não a conta,
              e a comunidade vem da instalação — inclusive depois de ela ser
              desativada, já que a FK preserva o vínculo com o histórico. */}
          {item.publisher === 'devvit'
            ? 'App Devvit'
            : `u/${item.reddit_accounts?.username ?? '—'}`}{' '}
          → r/
          {item.subreddits?.name ??
            item.devvit_installations?.subreddit_name ??
            '—'}
        </td>
        <td className="max-w-xs truncate px-4 py-3 text-claro">
          {item.title}
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          <StatusChip
            status={item.status}
            rotulo={
              rotuloDevvit(
                item.status,
                item.publisher,
                item.devvit_sync_status,
              ) ?? undefined
            }
          />
          {item.retry_count > 0 && (
            <span className="ml-1.5 text-xs tabular-nums text-fraco">
              {item.retry_count} tentativa(s)
            </span>
          )}
          {item.devvit_sync_status === 'failed' && item.devvit_sync_error && (
            <span className="ml-1.5 text-xs text-rosa/90">
              {item.devvit_sync_error}
            </span>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-3">
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
                className="text-xs text-medio underline underline-offset-2 transition-colors duration-150 hover:text-claro"
              >
                Reagendar
              </button>
              <form action={cancelar}>
                <input type="hidden" name="postId" value={item.id} />
                <button
                  type="submit"
                  disabled={cancelando}
                  className="text-xs text-rosa/90 underline underline-offset-2 transition-colors duration-150 hover:text-rosa disabled:opacity-60"
                >
                  Cancelar
                </button>
              </form>
            </div>
          ) : (
            <span className="text-xs text-fraco/80">—</span>
          )}
        </td>
      </tr>

      {(estadoCancelar.error || estadoReagendar.error) && (
        <tr>
          <td colSpan={5} className="px-3 pb-2">
            <p className="text-xs text-rosa" role="alert">
              {estadoCancelar.error ?? estadoReagendar.error}
            </p>
          </td>
        </tr>
      )}

      {aberto && editavel && (
        <tr className="border-b border-white/5">
          <td colSpan={5} className="anima-painel bg-eleva px-4 py-3.5">
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
