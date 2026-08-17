import { createServerSupabase } from '@/lib/supabase/server'
import { QueueFilters } from '@/components/queue/queue-filters'
import { QueueTable, type QueueRow } from '@/components/queue/queue-table'
import { POST_STATUSES, QUEUE_STATUSES } from '@/lib/scheduling/status'
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

export default async function QueuePage({
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

  // Os filtros entram na CONSULTA, e não em um `.filter()` depois: filtrar no
  // cliente traria para o navegador linhas que o usuário pediu para não ver, e
  // pagaria banda por dados descartados.
  let consulta = supabase
    .from('scheduled_posts')
    .select(
      `id, title, status, scheduled_at, timezone, post_kind, url,
       error_message, retry_count, next_attempt_at,
       reddit_account_id, subreddit_id,
       reddit_accounts ( username ),
       subreddits!scheduled_posts_subreddit_id_owner_id_fkey ( name )`,
    )
    .order('scheduled_at', { ascending: true })

  // Cada parâmetro é validado antes de virar filtro. Um valor inesperado é
  // ignorado em vez de ir para a consulta.
  const status =
    params.status && (POST_STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : null

  consulta = status
    ? consulta.eq('status', status)
    : consulta.in('status', QUEUE_STATUSES as unknown as string[])

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
        Fila
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        O que ainda vai acontecer, em ordem cronológica.
      </p>

      <QueueFilters
        contas={contas ?? []}
        comunidades={comunidades ?? []}
        atual={{ ...params, tz: fuso }}
      />

      <QueueTable
        itens={(itens ?? []) as unknown as QueueRow[]}
        timeZone={fuso}
      />
    </div>
  )
}
