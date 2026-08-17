import Link from 'next/link'
import { createServerSupabase } from '@/lib/supabase/server'
import { corStatus, rotuloStatus } from '@/lib/scheduling/status'
import { fromUtc, SUPPORTED_TIME_ZONES, toUtc } from '@/lib/scheduling/timezone'

export default async function DashboardPage() {
  const supabase = await createServerSupabase()

  const { data: perfil } = await supabase
    .from('profiles')
    .select('timezone')
    .maybeSingle()

  const fuso =
    perfil?.timezone &&
    (SUPPORTED_TIME_ZONES as readonly string[]).includes(perfil.timezone)
      ? (perfil.timezone as string)
      : 'America/Sao_Paulo'

  // "Hoje" é o dia do USUÁRIO, não o do servidor. Um contador em UTC diria
  // "nenhuma publicação hoje" às 22h em São Paulo, quando já é o dia seguinte
  // em UTC — e a pessoa acharia que o agendamento sumiu.
  const hojeLocal = fromUtc(new Date(), fuso).date
  const inicioHoje = toUtc({ date: hojeLocal, time: '00:00', timeZone: fuso })
  const fimHoje = new Date(inicioHoje.getTime() + 86_400_000)

  const contar = async (
    aplicar: (q: ReturnType<typeof base>) => ReturnType<typeof base>,
  ) => {
    const { count } = await aplicar(base())
    return count ?? 0
  }
  function base() {
    return supabase
      .from('scheduled_posts')
      .select('id', { count: 'exact', head: true })
  }

  const [hoje, publicados, pendentes, falhas, emRevisao] = await Promise.all([
    contar((q) =>
      q
        .gte('scheduled_at', inicioHoje.toISOString())
        .lt('scheduled_at', fimHoje.toISOString()),
    ),
    contar((q) => q.eq('status', 'published')),
    contar((q) => q.in('status', ['draft', 'scheduled', 'processing'])),
    contar((q) => q.eq('status', 'failed')),
    contar((q) => q.eq('status', 'needs_review')),
  ])

  const { data: proximas } = await supabase
    .from('scheduled_posts')
    .select(
      `id, title, status, scheduled_at,
       reddit_accounts ( username ),
       subreddits!scheduled_posts_subreddit_id_owner_id_fkey ( name )`,
    )
    .in('status', ['scheduled', 'processing'])
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(8)

  type Proxima = {
    id: string
    title: string
    status: string
    scheduled_at: string
    reddit_accounts: { username: string } | null
    subreddits: { name: string } | null
  }
  const lista = (proximas ?? []) as unknown as Proxima[]

  return (
    <div>
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Dashboard
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Horários no fuso do seu perfil ({fuso}).
      </p>

      {emRevisao > 0 && (
        <Link
          href="/dashboard/review"
          className="mt-5 block rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <strong>{emRevisao}</strong> publicação(ões) aguardando sua decisão. O
          resultado não pôde ser confirmado e o sistema não tenta de novo
          sozinho.
        </Link>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Indicador rotulo="Hoje" valor={hoje} />
        <Indicador rotulo="Publicados" valor={publicados} />
        <Indicador rotulo="Pendentes" valor={pendentes} />
        <Indicador rotulo="Falhas" valor={falhas} />
      </dl>

      <h2 className="mt-8 text-sm font-medium text-neutral-900 dark:text-neutral-50">
        Próximas publicações
      </h2>

      {lista.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">
          Nada programado.{' '}
          <Link href="/dashboard/new" className="underline">
            Agendar uma publicação
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
          {lista.map((p) => {
            const local = fromUtc(new Date(p.scheduled_at), fuso)
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <span className="whitespace-nowrap text-neutral-600 dark:text-neutral-400">
                  {local.date} {local.time}
                </span>
                <span className="whitespace-nowrap text-xs text-neutral-500">
                  u/{p.reddit_accounts?.username ?? '—'} → r/
                  {p.subreddits?.name ?? '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-900 dark:text-neutral-50">
                  {p.title}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${corStatus(p.status)}`}
                >
                  {rotuloStatus(p.status)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Indicador({ rotulo, valor }: { rotulo: string; valor: number }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <dt className="text-xs text-neutral-500">{rotulo}</dt>
      <dd className="mt-0.5 text-2xl font-semibold text-neutral-900 dark:text-neutral-50">
        {valor}
      </dd>
    </div>
  )
}
