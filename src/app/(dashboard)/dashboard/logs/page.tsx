import { createServerSupabase } from '@/lib/supabase/server'
import {
  botaoPrimario,
  cabecalhoTabela,
  campo,
  descricaoPagina,
  estadoVazio,
  modulo,
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

// O mesmo código de estado discreto dos chips de publicação: chip cinza,
// desfecho indicado só pelo ponto dessaturado.
const PONTO_OUTCOME: Record<string, string> = {
  success: 'bg-salvia',
  failure: 'bg-rosa',
  retry: 'bg-aco',
  unknown: 'bg-areia',
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
    <div className="anima-entrada">
      <h1 className={tituloPagina}>Logs</h1>
      <p className={descricaoPagina}>
        Registro das operações do worker. As mensagens já chegam sanitizadas:
        nenhum token, senha de proxy ou credencial em URL é gravado.
      </p>

      <form
        method="get"
        action="/dashboard/logs"
        className="mt-6 flex flex-wrap items-end gap-3"
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
        <div className={`${estadoVazio} mt-6`}>Nenhum registro ainda.</div>
      ) : (
        <div className={`${modulo} mt-4 overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className={cabecalhoTabela}>
              <tr>
                <th className="px-4 py-2.5 font-medium">Quando</th>
                <th className="px-4 py-2.5 font-medium">Ação</th>
                <th className="px-4 py-2.5 font-medium">Desfecho</th>
                <th className="px-4 py-2.5 font-medium">HTTP</th>
                <th className="px-4 py-2.5 font-medium">Duração</th>
                <th className="px-4 py-2.5 font-medium">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {logs!.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.03]"
                >
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs tabular-nums text-fraco">
                    {new Date(l.created_at).toLocaleString('pt-BR')}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-claro">
                    {l.action === 'submit_post' ? 'Publicação' : 'Comentário'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-traco bg-white/5 px-2 py-0.5 text-xs text-medio">
                      <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${
                          PONTO_OUTCOME[l.outcome] ?? 'bg-fraco'
                        }`}
                      />
                      {ROTULO_OUTCOME[l.outcome] ?? l.outcome}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs tabular-nums text-fraco">
                    {l.http_status ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs tabular-nums text-fraco">
                    {l.duration_ms != null ? `${l.duration_ms} ms` : '—'}
                  </td>
                  <td className="max-w-md px-4 py-3 text-medio">
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
