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

  const seta =
    'rounded-lg border border-traco px-2.5 py-1 text-sm text-medio transition-colors duration-150 hover:border-traco-forte hover:text-claro active:scale-[0.98]'

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Link href={link(anterior.y, anterior.m)} aria-label="Mês anterior" className={seta}>
            ←
          </Link>
          <span className="text-sm font-medium text-claro">
            {MESES[month - 1]}{' '}
            <span className="tabular-nums text-fraco">{year}</span>
          </span>
          <Link href={link(proximo.y, proximo.m)} aria-label="Próximo mês" className={seta}>
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

      <div className="mt-4 grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-traco bg-traco">
        {SEMANA.map((d) => (
          <div
            key={d}
            className="bg-superficie px-2 py-2 text-center text-[11px] font-medium text-fraco"
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
              className={`min-h-24 bg-fundo p-1.5 ${dia.inMonth ? '' : 'opacity-40'}`}
            >
              <span className="px-1 text-[11px] tabular-nums text-fraco">
                {dia.day}
              </span>

              <ul className="mt-1 space-y-0.5">
                {visiveis.map((p) => {
                  const { time } = fromUtc(new Date(p.scheduled_at), timeZone)
                  return (
                    <li key={p.id}>
                      {/*
                        O estado aparece só no ponto — o mesmo código de cor
                        discreto dos chips, sem pintar a célula.
                      */}
                      <Link
                        href={`/dashboard/queue?from=${dia.date}&to=${dia.date}`}
                        title={`${p.title} — ${rotuloStatus(p.status)}`}
                        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] leading-4 text-medio transition-colors duration-150 hover:bg-white/5 hover:text-claro"
                      >
                        <span
                          aria-hidden
                          className={`size-1 shrink-0 rounded-full ${corStatus(p.status)}`}
                        />
                        <span className="tabular-nums">{time}</span>
                        <span className="truncate">{p.title}</span>
                      </Link>
                    </li>
                  )
                })}
              </ul>

              {resto > 0 && (
                <Link
                  href={`/dashboard/queue?from=${dia.date}&to=${dia.date}`}
                  className="mt-0.5 block px-1 text-[11px] tabular-nums text-fraco transition-colors duration-150 hover:text-claro"
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
