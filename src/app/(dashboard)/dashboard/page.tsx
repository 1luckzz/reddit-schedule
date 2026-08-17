import Link from 'next/link'
import { createServerSupabase } from '@/lib/supabase/server'
import { StatusChip } from '@/components/ui/status-chip'
import { StudioClock } from '@/components/ui/studio-clock'
import {
  descricaoPagina,
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

  const [hoje, publicados, pendentes, falhas, emRevisao, noAr] =
    await Promise.all([
      contar((q) =>
        q
          .gte('scheduled_at', inicioHoje.toISOString())
          .lt('scheduled_at', fimHoje.toISOString()),
      ),
      contar((q) => q.eq('status', 'published')),
      contar((q) => q.in('status', ['draft', 'scheduled', 'processing'])),
      contar((q) => q.eq('status', 'failed')),
      contar((q) => q.eq('status', 'needs_review')),
      // A lâmpada da linha de transmissão: algo sendo publicado NESTE momento.
      contar((q) => q.eq('status', 'processing')),
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
    <div className="max-w-4xl">
      <p className={plaqueta}>Mesa de controle</p>
      <h1 className={tituloPagina}>Dashboard</h1>
      <p className={descricaoPagina}>
        Horários no fuso do seu perfil ({fuso}).
      </p>

      {/* A linha de transmissão: o estado geral do transmissor, num relance. */}
      <div
        className={`${modulo} mt-5 flex flex-wrap items-center justify-between gap-3 px-4 py-2.5`}
      >
        {noAr > 0 ? (
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="size-2.5 rounded-full bg-noar lampada-noar"
            />
            <span className="font-display text-sm font-semibold uppercase tracking-[0.16em] text-noar">
              No ar
            </span>
            <span className="text-sm text-fosforo-dim">
              {noAr} publicação(ões) sendo transmitida(s) agora
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="size-2.5 rounded-full bg-standby" />
            <span className="font-display text-sm font-medium uppercase tracking-[0.16em] text-standby">
              Standby
            </span>
            <span className="text-sm text-fosforo-dim">
              aguardando o próximo horário da grade
            </span>
          </div>
        )}
        <StudioClock timeZone={fuso} />
      </div>

      {emRevisao > 0 && (
        <Link
          href="/dashboard/review"
          className="mt-4 flex items-center gap-2.5 rounded-md border border-ambar/40 bg-ambar/10 p-3 text-sm text-fosforo transition-colors hover:bg-ambar/15"
        >
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-ambar" />
          <span>
            <strong className="font-mono">{emRevisao}</strong> publicação(ões)
            aguardando sua decisão. O resultado não pôde ser confirmado e o
            sistema não tenta de novo sozinho.
          </span>
        </Link>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Indicador rotulo="Hoje" valor={hoje} />
        <Indicador rotulo="Publicados" valor={publicados} />
        <Indicador rotulo="Pendentes" valor={pendentes} />
        <Indicador rotulo="Falhas" valor={falhas} alerta={falhas > 0} />
      </dl>

      <h2 className={`${plaqueta} mt-8`}>Próximas publicações</h2>

      {lista.length === 0 ? (
        <p className="mt-2 text-sm text-fosforo-dim">
          Nada programado.{' '}
          <Link href="/dashboard/new" className="text-ambar underline">
            Agendar uma publicação
          </Link>
          .
        </p>
      ) : (
        <ul className={`${modulo} mt-2 divide-y divide-risco/60`}>
          {lista.map((p) => {
            const local = fromUtc(new Date(p.scheduled_at), fuso)
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
              >
                <span className="font-mono text-[13px] tabular-nums text-ambar">
                  {local.time}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-fosforo-dim">
                  {local.date}
                </span>
                <span className="whitespace-nowrap text-xs text-fosforo-dim">
                  u/{p.reddit_accounts?.username ?? '—'} → r/
                  {p.subreddits?.name ?? '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-fosforo">
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

function Indicador({
  rotulo,
  valor,
  alerta = false,
}: {
  rotulo: string
  valor: number
  alerta?: boolean
}) {
  return (
    <div className={`${modulo} p-3`}>
      <dt className={plaqueta}>{rotulo}</dt>
      <dd
        className={`mt-1 font-mono text-[32px] leading-9 tabular-nums ${
          alerta ? 'text-tijolo' : 'text-fosforo'
        }`}
      >
        {valor}
      </dd>
    </div>
  )
}
