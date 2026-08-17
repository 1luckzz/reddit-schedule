import { createServerSupabase } from '@/lib/supabase/server'

type Params = { action?: string; outcome?: string }

const OUTCOMES = ['success', 'failure', 'retry', 'unknown'] as const
const ACOES = ['submit_post', 'submit_comment'] as const

const ROTULO_OUTCOME: Record<string, string> = {
  success: 'Sucesso',
  failure: 'Falha',
  retry: 'Retentativa',
  unknown: 'Resultado desconhecido',
}

const COR_OUTCOME: Record<string, string> = {
  success:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failure: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  retry: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  unknown: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
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

  const campo =
    'rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900'

  return (
    <div>
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Logs
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Registro das operações do worker. As mensagens já chegam sanitizadas:
        nenhum token, senha de proxy ou credencial em URL é gravado.
      </p>

      <form
        method="get"
        action="/dashboard/logs"
        className="mt-5 flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
          Ação
          <select name="action" defaultValue={params.action ?? ''} className={campo}>
            <option value="">Todas</option>
            <option value="submit_post">Publicação</option>
            <option value="submit_comment">Comentário</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
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
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white dark:bg-neutral-50 dark:text-neutral-900"
        >
          Filtrar
        </button>
      </form>

      {(logs ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">Nenhum registro ainda.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
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
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-600 dark:text-neutral-400">
                    {new Date(l.created_at).toLocaleString('pt-BR')}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-700 dark:text-neutral-300">
                    {l.action === 'submit_post' ? 'Publicação' : 'Comentário'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        COR_OUTCOME[l.outcome] ?? ''
                      }`}
                    >
                      {ROTULO_OUTCOME[l.outcome] ?? l.outcome}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                    {l.http_status ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                    {l.duration_ms != null ? `${l.duration_ms} ms` : '—'}
                  </td>
                  <td className="max-w-md px-3 py-2 text-neutral-600 dark:text-neutral-400">
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
