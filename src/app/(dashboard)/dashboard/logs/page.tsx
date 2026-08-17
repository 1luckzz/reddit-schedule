import { createServerSupabase } from '@/lib/supabase/server'
import {
  botaoPrimario,
  cabecalhoTabela,
  campo,
  descricaoPagina,
  modulo,
  plaqueta,
  rotuloCampo,
  tituloPagina,
} from '@/components/ui/estilo'

type Params = { action?: string; outcome?: string }

const OUTCOMES = ['success', 'failure', 'retry', 'unknown'] as const
const ACOES = ['submit_post', 'submit_comment'] as const

const ROTULO_OUTCOME: Record<string, string> = {
  success: 'Sucesso',
  failure: 'Falha',
  retry: 'Retentativa',
  unknown: 'Resultado desconhecido',
}

// A mesma linguagem de lâmpada dos status de publicação: verde para o que
// concluiu, tijolo fosco para falha, azul para retentativa, âmbar para o
// desfecho que precisa de atenção humana.
const COR_OUTCOME: Record<string, string> = {
  success: 'text-ok border-ok/30 bg-ok/10',
  failure: 'text-tijolo border-tijolo/35 bg-tijolo/10',
  retry: 'text-standby border-standby/30 bg-standby/10',
  unknown: 'text-ambar border-ambar/35 bg-ambar/10',
}

const LAMPADA_OUTCOME: Record<string, string> = {
  success: 'bg-ok',
  failure: 'bg-tijolo',
  retry: 'bg-standby',
  unknown: 'bg-ambar',
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const params = await searchParams
  const supabase = await createServerSupabase()

  let consulta = supabase
    .from('execution_logs')
    .select(
      'id, action, outcome, http_status, error_code, error_message, duration_ms, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(200)

  if (params.action && (ACOES as readonly string[]).includes(params.action)) {
    consulta = consulta.eq('action', params.action)
  }
  if (
    params.outcome &&
    (OUTCOMES as readonly string[]).includes(params.outcome)
  ) {
    consulta = consulta.eq('outcome', params.outcome)
  }

  const { data: logs } = await consulta

  return (
    <div>
      <p className={plaqueta}>Telemetria do transmissor</p>
      <h1 className={tituloPagina}>Logs</h1>
      <p className={descricaoPagina}>
        Registro das operações do worker. As mensagens já chegam sanitizadas:
        nenhum token, senha de proxy ou credencial em URL é gravado.
      </p>

      <form
        method="get"
        action="/dashboard/logs"
        className={`${modulo} mt-5 flex flex-wrap items-end gap-3 p-3`}
      >
        <label className={rotuloCampo}>
          Ação
          <select name="action" defaultValue={params.action ?? ''} className={campo}>
            <option value="">Todas</option>
            <option value="submit_post">Publicação</option>
            <option value="submit_comment">Comentário</option>
          </select>
        </label>
        <label className={rotuloCampo}>
          Desfecho
          <select
            name="outcome"
            defaultValue={params.outcome ?? ''}
            className={campo}
          >
            <option value="">Todos</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {ROTULO_OUTCOME[o]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={botaoPrimario}>
          Filtrar
        </button>
      </form>

      {(logs ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-fosforo-dim">Nenhum registro ainda.</p>
      ) : (
        <div className={`${modulo} mt-4 overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className={cabecalhoTabela}>
              <tr>
                <th className="px-3 py-2 font-medium">Quando</th>
                <th className="px-3 py-2 font-medium">Ação</th>
                <th className="px-3 py-2 font-medium">Desfecho</th>
                <th className="px-3 py-2 font-medium">HTTP</th>
                <th className="px-3 py-2 font-medium">Duração</th>
                <th className="px-3 py-2 font-medium">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {logs!.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-risco/60 transition-colors last:border-0 hover:bg-console-2/50"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] tabular-nums text-fosforo-dim">
                    {new Date(l.created_at).toLocaleString('pt-BR')}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-fosforo">
                    {l.action === 'submit_post' ? 'Publicação' : 'Comentário'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-display text-[11px] font-medium uppercase tracking-[0.08em] ${
                        COR_OUTCOME[l.outcome] ?? ''
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${
                          LAMPADA_OUTCOME[l.outcome] ?? 'bg-fosforo-dim'
                        }`}
                      />
                      {ROTULO_OUTCOME[l.outcome] ?? l.outcome}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] tabular-nums text-fosforo-dim">
                    {l.http_status ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] tabular-nums text-fosforo-dim">
                    {l.duration_ms != null ? `${l.duration_ms} ms` : '—'}
                  </td>
                  <td className="max-w-md px-3 py-2 text-fosforo-dim">
                    {l.error_message ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
