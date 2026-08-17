import { createServerSupabase } from '@/lib/supabase/server'
import { modulo, plaqueta, tituloPagina } from '@/components/ui/estilo'
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
    <div className="anima-entrada max-w-2xl">
      <h1 className={tituloPagina}>Configurações</h1>

      {/* O status do worker é o destaque; o resto são linhas quietas. */}
      <section className={`${modulo} mt-6 p-5`}>
        <h2 className={plaqueta}>Status do worker</h2>

        {saude.parado ? (
          <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-rosa/30 bg-rosa/10 p-3.5">
            <span
              aria-hidden
              className="mt-[7px] size-1.5 shrink-0 rounded-full bg-rosa"
            />
            <p className="text-sm text-claro">
              <strong className="font-semibold text-forte">
                {saude.atrasadas} publicação(ões) já venceram e continuam na
                fila.
              </strong>{' '}
              Isso indica que o worker não está rodando — os agendamentos não
              serão publicados até que ele volte.
            </p>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2.5">
            <span aria-hidden className="size-1.5 rounded-full bg-salvia" />
            <p className="text-sm text-medio">
              Nenhuma publicação vencida na fila.
            </p>
          </div>
        )}

        <dl className="mt-4 space-y-1 text-sm">
          <div className="flex flex-wrap gap-2">
            <dt className="text-fraco">Última atividade registrada:</dt>
            <dd className="tabular-nums text-claro">
              {saude.minutosDesdeAtividade === null
                ? 'nenhuma ainda'
                : `${saude.minutosDesdeAtividade} min atrás`}
            </dd>
          </div>
        </dl>

        {saude.ocioso && !saude.parado && (
          <p className="mt-2 text-xs text-fraco">
            Sem atividade nos últimos {LIMITE_INATIVIDADE_MINUTOS} minutos. Isso
            é esperado quando não há nada agendado — o worker só registra
            quando publica.
          </p>
        )}

        <p className="mt-4 border-t border-white/5 pt-3 text-xs text-fraco">
          O intervalo do ciclo, o tamanho do lote e o tempo do reaper são
          definidos por variáveis de ambiente na máquina do worker, e por isso
          não são editáveis aqui.
        </p>
      </section>

      <section className="mt-8 border-t border-traco pt-5">
        <h2 className="text-sm font-medium text-claro">
          Integração com o Reddit
        </h2>
        {/*
          Apenas se está configurada. O segredo do app NUNCA é exibido, nem
          parcialmente: um prefixo já reduz o espaço de busca de quem tentar
          adivinhar, e não há nada que a interface ganhe em mostrá-lo.
        */}
        <p className="mt-1.5 text-sm text-medio">
          As credenciais do app OAuth ficam no ambiente do servidor. Elas não
          são exibidas aqui, nem parcialmente.
        </p>
      </section>

      <section className="mt-6 border-t border-traco pt-5">
        <h2 className="text-sm font-medium text-claro">
          Fuso horário do perfil
        </h2>
        <p className="mt-1.5 text-sm text-medio">
          <span className="text-claro">
            {perfil?.timezone ?? 'America/Sao_Paulo'}
          </span>{' '}
          — usado para definir o que é &quot;hoje&quot; nos indicadores do
          Dashboard.
        </p>
      </section>
    </div>
  )
}
