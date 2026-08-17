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
    <div className="max-w-2xl">
      <p className={plaqueta}>Cabine técnica</p>
      <h1 className={tituloPagina}>Configurações</h1>

      <section className={`${modulo} mt-6 p-4`}>
        <h2 className={plaqueta}>Status do worker</h2>

        {saude.parado ? (
          <div className="mt-3 flex items-start gap-2.5 rounded-sm border border-tijolo/40 bg-tijolo/10 p-3">
            <span
              aria-hidden
              className="mt-1 size-2.5 shrink-0 rounded-full bg-tijolo"
            />
            <p className="text-sm text-fosforo">
              <strong>
                {saude.atrasadas} publicação(ões) já venceram e continuam na
                fila.
              </strong>{' '}
              Isso indica que o worker não está rodando — os agendamentos não
              serão publicados até que ele volte.
            </p>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2.5">
            <span aria-hidden className="size-2.5 rounded-full bg-ok" />
            <p className="text-sm text-fosforo-dim">
              Nenhuma publicação vencida na fila.
            </p>
          </div>
        )}

        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex flex-wrap gap-2">
            <dt className="text-fosforo-dim">Última atividade registrada:</dt>
            <dd className="font-mono text-[13px] text-fosforo">
              {saude.minutosDesdeAtividade === null
                ? 'nenhuma ainda'
                : `${saude.minutosDesdeAtividade} min atrás`}
            </dd>
          </div>
        </dl>

        {saude.ocioso && !saude.parado && (
          <p className="mt-2 text-xs text-fosforo-dim">
            Sem atividade nos últimos {LIMITE_INATIVIDADE_MINUTOS} minutos. Isso
            é esperado quando não há nada agendado — o worker só registra
            quando publica.
          </p>
        )}

        <p className="mt-3 text-xs text-fosforo-dim">
          O intervalo do ciclo, o tamanho do lote e o tempo do reaper são
          definidos por variáveis de ambiente na máquina do worker, e por isso
          não são editáveis aqui.
        </p>
      </section>

      <section className={`${modulo} mt-4 p-4`}>
        <h2 className={plaqueta}>Integração com o Reddit</h2>
        {/*
          Apenas se está configurada. O segredo do app NUNCA é exibido, nem
          parcialmente: um prefixo já reduz o espaço de busca de quem tentar
          adivinhar, e não há nada que a interface ganhe em mostrá-lo.
        */}
        <p className="mt-2 text-sm text-fosforo-dim">
          As credenciais do app OAuth ficam no ambiente do servidor. Elas não
          são exibidas aqui, nem parcialmente.
        </p>
      </section>

      <section className={`${modulo} mt-4 p-4`}>
        <h2 className={plaqueta}>Fuso horário do perfil</h2>
        <p className="mt-2 text-sm text-fosforo-dim">
          <span className="font-mono text-[13px] text-fosforo">
            {perfil?.timezone ?? 'America/Sao_Paulo'}
          </span>{' '}
          — usado para definir o que é &quot;hoje&quot; nos indicadores do
          Dashboard.
        </p>
      </section>
    </div>
  )
}
