import { createServerSupabase } from '@/lib/supabase/server'
import { QueueFilters } from '@/components/queue/queue-filters'
import {
  HistoryTable,
  type HistoryRow,
} from '@/components/history/history-table'
import { HISTORY_STATUSES } from '@/lib/scheduling/status'
import { SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

type Params = {
  account?: string
  community?: string
  status?: string
  from?: string
  to?: string
  tz?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATA = /^\d{4}-\d{2}-\d{2}$/

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const params = await searchParams
  const supabase = await createServerSupabase()

  const { data: contas } = await supabase
    .from('reddit_accounts')
    .select('id, username')
    .order('username')

  const { data: comunidades } = await supabase
    .from('subreddits')
    .select('id, name, reddit_account_id')
    .eq('status', 'active')
    .order('name')

  const fuso =
    params.tz && (SUPPORTED_TIME_ZONES as readonly string[]).includes(params.tz)
      ? params.tz
      : 'America/Sao_Paulo'

  let consulta = supabase
    .from('scheduled_posts')
    .select(
      `id, title, status, scheduled_at, timezone, published_at,
       reddit_post_id, reddit_permalink, error_message, retry_count,
       resolved_by, resolved_at,
       reddit_accounts ( username ),
       subreddits!scheduled_posts_subreddit_id_owner_id_fkey ( name )`,
    )
    .order('scheduled_at', { ascending: false })

  const status =
    params.status &&
    (HISTORY_STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : null

  consulta = status
    ? consulta.eq('status', status)
    : consulta.in('status', HISTORY_STATUSES as unknown as string[])

  if (params.account && UUID.test(params.account)) {
    consulta = consulta.eq('reddit_account_id', params.account)
  }
  if (params.community && UUID.test(params.community)) {
    consulta = consulta.eq('subreddit_id', params.community)
  }
  if (params.from && DATA.test(params.from)) {
    consulta = consulta.gte('scheduled_at', `${params.from}T00:00:00.000Z`)
  }
  if (params.to && DATA.test(params.to)) {
    consulta = consulta.lte('scheduled_at', `${params.to}T23:59:59.999Z`)
  }

  const { data: itens } = await consulta

  return (
    <div>
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Histórico
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        O que já foi concluído. A diferença entre o horário planejado e o real
        revela atraso de fila, retentativa ou resolução manual.
      </p>

      <QueueFilters
        contas={contas ?? []}
        comunidades={comunidades ?? []}
        atual={{ ...params, tz: fuso }}
        action="/dashboard/history"
        statusDisponiveis={HISTORY_STATUSES}
      />

      <HistoryTable
        itens={(itens ?? []) as unknown as HistoryRow[]}
        timeZone={fuso}
      />
    </div>
  )
}
