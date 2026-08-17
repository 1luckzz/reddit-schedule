import { createServerSupabase } from '@/lib/supabase/server'
import { MonthGrid, type CalendarPost } from '@/components/calendar/month-grid'
import { buildMonthGrid, groupByDay } from '@/lib/scheduling/calendar'
import { SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

type Params = { year?: string; month?: string; tz?: string }

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const params = await searchParams
  const supabase = await createServerSupabase()

  const fuso =
    params.tz && (SUPPORTED_TIME_ZONES as readonly string[]).includes(params.tz)
      ? params.tz
      : 'America/Sao_Paulo'

  const hoje = new Date()
  const ano = Number(params.year) || hoje.getUTCFullYear()
  const mes =
    Number(params.month) >= 1 && Number(params.month) <= 12
      ? Number(params.month)
      : hoje.getUTCMonth() + 1

  const grade = buildMonthGrid(ano, mes)

  // A janela da consulta usa o primeiro e o último dia da GRADE, não do mês:
  // as células vizinhas também mostram publicações. Uma folga de um dia em
  // cada ponta cobre a diferença de fuso entre o corte UTC e o do usuário.
  const inicio = new Date(`${grade[0].date}T00:00:00.000Z`)
  inicio.setUTCDate(inicio.getUTCDate() - 1)
  const fim = new Date(`${grade[grade.length - 1].date}T23:59:59.999Z`)
  fim.setUTCDate(fim.getUTCDate() + 1)

  const { data: itens } = await supabase
    .from('scheduled_posts')
    .select(
      `id, title, status, scheduled_at, timezone,
       reddit_accounts ( username ),
       subreddits!scheduled_posts_subreddit_id_owner_id_fkey ( name )`,
    )
    .gte('scheduled_at', inicio.toISOString())
    .lte('scheduled_at', fim.toISOString())
    .order('scheduled_at', { ascending: true })

  const posts = (itens ?? []) as unknown as CalendarPost[]
  // Agrupamento no fuso do usuário: 22h em São Paulo é 01h do dia seguinte em
  // UTC, e agrupar por UTC colocaria a publicação na célula errada.
  const porDia = groupByDay(posts, fuso)

  return (
    <div>
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Calendário
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Publicações agrupadas por dia no fuso escolhido.
      </p>

      <MonthGrid
        year={ano}
        month={mes}
        timeZone={fuso}
        dias={grade}
        porDia={Object.fromEntries(porDia)}
      />
    </div>
  )
}
