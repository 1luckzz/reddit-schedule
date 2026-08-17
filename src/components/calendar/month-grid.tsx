import Link from 'next/link'
import type { CalendarDay } from '@/lib/scheduling/calendar'
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
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
          >
            ←
          </Link>
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
            {MESES[month - 1]} de {year}
          </span>
          <Link
            href={link(proximo.y, proximo.m)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
          >
            →
          </Link>
        </div>

        <form method="get" action="/dashboard/calendar" className="flex items-end gap-2">
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="month" value={month} />
          <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            Fuso
            <select
              name="tz"
              defaultValue={timeZone}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
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
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-neutral-50 dark:text-neutral-900"
          >
            Aplicar
          </button>
        </form>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-neutral-200 bg-neutral-200 dark:border-neutral-800 dark:bg-neutral-800">
        {SEMANA.map((d) => (
          <div
            key={d}
            className="bg-neutral-50 px-2 py-1.5 text-center text-xs font-medium text-neutral-500 dark:bg-neutral-950"
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
              className={`min-h-24 bg-white p-1.5 dark:bg-neutral-900 ${
                dia.inMonth ? '' : 'opacity-50'
              }`}
            >
              <span className="text-xs text-neutral-500">{dia.day}</span>

              <ul className="mt-1 space-y-1">
                {visiveis.map((p) => {
                  const { time } = fromUtc(new Date(p.scheduled_at), timeZone)
                  return (
                    <li key={p.id}>
                      <Link
                        href={`/dashboard/queue?from=${dia.date}&to=${dia.date}`}
                        title={`${p.title} — ${rotuloStatus(p.status)}`}
                        className={`block truncate rounded px-1 py-0.5 text-[11px] ${corStatus(p.status)}`}
                      >
                        {time} u/{p.reddit_accounts?.username ?? '—'} · {p.title}
                      </Link>
                    </li>
                  )
                })}
              </ul>

              {resto > 0 && (
                <Link
                  href={`/dashboard/queue?from=${dia.date}&to=${dia.date}`}
                  className="mt-1 block text-[11px] text-neutral-500 underline"
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
