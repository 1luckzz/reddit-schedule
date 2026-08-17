import Link from 'next/link'
import { createServerSupabase } from '@/lib/supabase/server'
import { StatusChip } from '@/components/ui/status-chip'
import {
  botaoPrimario,
  descricaoPagina,
  estadoVazio,
  modulo,
  plaqueta,
  tituloPagina,
} from '@/components/ui/estilo'
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

  const metricas = [
    { rotulo: 'Hoje', valor: hoje },
    { rotulo: 'Publicados', valor: publicados },
    { rotulo: 'Pendentes', valor: pendentes },
    { rotulo: 'Falhas', valor: falhas },
  ]

  return (
    <div className="anima-entrada max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className={tituloPagina}>Dashboard</h1>
          <p className={descricaoPagina}>
            Horários no fuso do seu perfil ({fuso}).
          </p>
        </div>
        <Link href="/dashboard/new" className={botaoPrimario}>
          Nova publicação
        </Link>
      </div>

      {emRevisao > 0 && (
        <Link
          href="/dashboard/review"
          className="mt-6 flex items-center gap-2.5 rounded-xl border border-traco bg-white/[0.03] p-3.5 text-sm text-claro transition-colors duration-150 hover:border-traco-forte"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-areia" />
          <span>
            <strong className="font-semibold text-forte">{emRevisao}</strong>{' '}
            publicação(ões) aguardando sua decisão. O resultado não pôde ser
            confirmado e o sistema não tenta de novo sozinho.
          </span>
          <span aria-hidden className="ml-auto text-fraco">
            →
          </span>
        </Link>
      )}

      {/*
        Métricas como uma régua única com divisórias — não quatro cards
        idênticos. Os números são um dos poucos lugares do branco pleno.
      */}
      <dl
        className={`${modulo} mt-6 grid grid-cols-2 divide-y divide-traco sm:grid-cols-4 sm:divide-x sm:divide-y-0`}
      >
        {metricas.map((m) => (
          <div key={m.rotulo} className="px-5 py-4">
            <dt className="text-[13px] text-medio">{m.rotulo}</dt>
            <dd
              className={`mt-1 text-[28px] font-semibold leading-9 tracking-[-0.02em] tabular-nums ${
                m.rotulo === 'Falhas' && m.valor > 0
                  ? 'text-rosa'
                  : 'text-forte'
              }`}
            >
              {m.valor}
            </dd>
          </div>
        ))}
      </dl>

      {/* Lista sem moldura: composição diferente da régua de métricas. */}
      <div className="mt-10 flex items-baseline justify-between">
        <h2 className={plaqueta}>Próximas publicações</h2>
        <Link
          href="/dashboard/queue"
          className="text-[13px] text-fraco transition-colors duration-150 hover:text-claro"
        >
          Ver fila →
        </Link>
      </div>

      {lista.length === 0 ? (
        <div className={`${estadoVazio} mt-3`}>
          <p>Nada programado.</p>
          <Link
            href="/dashboard/new"
            className="mt-3 inline-block text-claro underline underline-offset-4 transition-colors duration-150 hover:text-forte"
          >
            Agendar uma publicação
          </Link>
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-white/5">
          {lista.map((p) => {
            const local = fromUtc(new Date(p.scheduled_at), fuso)
            return (
              <li
                key={p.id}
                className="-mx-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-3 text-sm transition-colors duration-150 hover:bg-white/[0.03]"
              >
                <span className="tabular-nums text-claro">{local.time}</span>
                <span className="text-[13px] tabular-nums text-fraco">
                  {local.date}
                </span>
                <span className="whitespace-nowrap text-[13px] text-fraco">
                  u/{p.reddit_accounts?.username ?? '—'} → r/
                  {p.subreddits?.name ?? '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-claro">
                  {p.title}
                </span>
                <StatusChip status={p.status} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
