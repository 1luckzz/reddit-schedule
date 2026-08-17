import { createServerSupabase } from '@/lib/supabase/server'
import {
  avaliarSaude,
  corteDeAtraso,
  LIMITE_INATIVIDADE_MINUTOS,
} from '@/lib/worker/health'

export default async function SettingsPage() {
  const supabase = await createServerSupabase()
  const agora = new Date()

  const { data: perfil } = await supabase
    .from('profiles')
    .select('timezone')
    .maybeSingle()

  // O último registro do próprio usuário é o sinal disponível pelo painel: os
  // logs têm RLS por dono, e o painel não enxerga a tabela de infraestrutura
  // do worker.
  const { data: ultimo } = await supabase
    .from('execution_logs')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Publicações que já venceram e continuam esperando: este SIM é um sinal
  // confiável de worker parado, porque deveriam ter saído.
  const { count: atrasadas } = await supabase
    .from('scheduled_posts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'scheduled')
    .lt('scheduled_at', corteDeAtraso(agora).toISOString())

  const saude = avaliarSaude({
    ultimaAtividade: ultimo?.created_at
      ? new Date(ultimo.created_at as string)
      : null,
    atrasadas: atrasadas ?? 0,
    agora,
  })

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Configurações
      </h1>

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          Status do worker
        </h2>

        {saude.parado ? (
          <p className="mt-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            <strong>
              {saude.atrasadas} publicação(ões) já venceram e continuam na fila.
            </strong>{' '}
            Isso indica que o worker não está rodando — os agendamentos não
            serão publicados até que ele volte.
          </p>
        ) : (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Nenhuma publicação vencida na fila.
          </p>
        )}

        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex flex-wrap gap-2">
            <dt className="text-neutral-500">Última atividade registrada:</dt>
            <dd className="text-neutral-800 dark:text-neutral-200">
              {saude.minutosDesdeAtividade === null
                ? 'nenhuma ainda'
                : `${saude.minutosDesdeAtividade} min atrás`}
            </dd>
          </div>
        </dl>

        {saude.ocioso && !saude.parado && (
          <p className="mt-2 text-xs text-neutral-500">
            Sem atividade nos últimos {LIMITE_INATIVIDADE_MINUTOS} minutos. Isso
            é esperado quando não há nada agendado — o worker só registra
            quando publica.
          </p>
        )}

        <p className="mt-3 text-xs text-neutral-500">
          O intervalo do ciclo, o tamanho do lote e o tempo do reaper são
          definidos por variáveis de ambiente na máquina do worker, e por isso
          não são editáveis aqui.
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          Integração com o Reddit
        </h2>
        {/*
          Apenas se está configurada. O segredo do app NUNCA é exibido, nem
          parcialmente: um prefixo já reduz o espaço de busca de quem tentar
          adivinhar, e não há nada que a interface ganhe em mostrá-lo.
        */}
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          As credenciais do app OAuth ficam no ambiente do servidor. Elas não
          são exibidas aqui, nem parcialmente.
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          Fuso horário do perfil
        </h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {perfil?.timezone ?? 'America/Sao_Paulo'} — usado para definir o que é
          &quot;hoje&quot; nos indicadores do Dashboard.
        </p>
      </section>
    </div>
  )
}
