import Link from 'next/link'
import type { CalendarDay } from '@/lib/scheduling/calendar'
import { botaoPrimario, campo, rotuloCampo } from '@/components/ui/estilo'
import { corStatus, rotuloStatus } from '@/lib/scheduling/status'
import { fromUtc, SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

export type CalendarPost = {
  id: string
  title: string
  status: string
  scheduled_at: string
  timezone: string
  reddit_accounts: { username: string } | null
  subreddits: { name: string } | null
}

const SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
]

/** Quantos cards cabem numa célula antes do indicador "+N". */
const POR_CELULA = 3

export function MonthGrid({
  year,
  month,
  timeZone,
  dias,
  porDia,
}: {
  year: number
  month: number
  timeZone: string
  dias: readonly CalendarDay[]
  porDia: Record<string, CalendarPost[]>
}) {
  const anterior = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 }
  const proximo = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
  const link = (y: number, m: number) =>
    `/dashboard/calendar?year=${y}&month=${m}&tz=${encodeURIComponent(timeZone)}`

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href={link(anterior.y, anterior.m)}
            aria-label="Mês anterior"
            className="rounded-sm border border-risco px-2 py-1 text-sm text-fosforo-dim transition-colors hover:bg-console-2 hover:text-fosforo"
          >
            ←
          </Link>
          <span className="font-display text-base font-semibold uppercase tracking-[0.1em] text-fosforo">
            {MESES[month - 1]}{' '}
            <span className="font-mono text-sm font-normal tracking-normal text-fosforo-dim">
              {year}
            </span>
          </span>
          <Link
            href={link(proximo.y, proximo.m)}
            aria-label="Próximo mês"
            className="rounded-sm border border-risco px-2 py-1 text-sm text-fosforo-dim transition-colors hover:bg-console-2 hover:text-fosforo"
          >
            →
          </Link>
        </div>

        <form method="get" action="/dashboard/calendar" className="flex items-end gap-2">
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="month" value={month} />
          <label className={rotuloCampo}>
            Fuso
            <select name="tz" defaultValue={timeZone} className={campo}>
              {SUPPORTED_TIME_ZONES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={botaoPrimario}>
            Aplicar
          </button>
        </form>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-px overflow-hidden rounded-md border border-risco bg-risco">
        {SEMANA.map((d) => (
          <div
            key={d}
            className="bg-estudio px-2 py-1.5 text-center font-display text-[11px] font-medium uppercase tracking-[0.14em] text-fosforo-dim"
          >
            {d}
          </div>
        ))}

        {dias.map((dia) => {
          const doDia = porDia[dia.date] ?? []
          const visiveis = doDia.slice(0, POR_CELULA)
          const resto = doDia.length - visiveis.length

          return (
            <div
              key={dia.date}
              className={`min-h-24 bg-console p-1.5 ${
                dia.inMonth ? '' : 'opacity-45'
              }`}
            >
              <span className="font-mono text-[11px] tabular-nums text-fosforo-dim">
                {dia.day}
              </span>

              <ul className="mt-1 space-y-1">
                {visiveis.map((p) => {
                  const { time } = fromUtc(new Date(p.scheduled_at), timeZone)
                  return (
                    <li key={p.id}>
                      {/*
                        Cada publicação é uma barra de sinal: régua à esquerda
                        na cor do estado, horário em mono. A cor É o estado —
                        a mesma linguagem de lâmpada do resto do console.
                      */}
                      <Link
                        href={`/dashboard/queue?from=${dia.date}&to=${dia.date}`}
                        title={`${p.title} — ${rotuloStatus(p.status)}`}
                        className={`block truncate rounded-r-sm border-l-2 py-0.5 pl-1.5 pr-1 text-[11px] leading-4 transition-colors hover:bg-console-2 ${corStatus(p.status)}`}
                      >
                        <span className="font-mono tabular-nums">{time}</span>{' '}
                        u/{p.reddit_accounts?.username ?? '—'} · {p.title}
                      </Link>
                    </li>
                  )
                })}
              </ul>

              {resto > 0 && (
                <Link
                  href={`/dashboard/queue?from=${dia.date}&to=${dia.date}`}
                  className="mt-1 block font-mono text-[11px] text-fosforo-dim underline transition-colors hover:text-fosforo"
                >
                  +{resto}
                </Link>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
