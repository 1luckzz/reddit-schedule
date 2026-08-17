import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Dispatcher } from 'undici'
import type { SupabaseClient } from '@supabase/supabase-js'
import { workerServiceClient } from './supabase'
import { getRedditEnv } from '@/lib/config/env'
import { getBudgetWith } from '@/lib/reddit/budget-core'
import { sanitize } from '@/lib/logging/sanitize'
import { getWorkerConfig, type WorkerConfig } from '@/lib/worker/config'
import { runPost, type PostJob } from './post-runner'
import { runComment, type CommentJob } from './comment-runner'

if (existsSync('.env.local')) process.loadEnvFile('.env.local')

export type CycleReport = {
  reaped: number
  posts: Record<string, number>
  comments: Record<string, number>
  pausedForBudget: boolean
}

const dormir = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

let parando = false

/**
 * Renova o lock periodicamente enquanto o job roda.
 *
 * Existe para o caso irredutível: um único job pode demorar mais que o timeout
 * do reaper — refresh de token lento, proxy ruim, upstream demorado. Sem
 * heartbeat, o reaper de outra instância recuperaria um job que ainda está
 * vivo, e o mesmo conteúdo sairia duas vezes.
 *
 * O intervalo é um terço do timeout, para tolerar uma renovação perdida. O
 * piso precisa ficar CONFORTAVELMENTE ABAIXO do timeout, senão o heartbeat
 * fica inerte justamente nas configurações mais apertadas — que são as que
 * mais precisam dele. Como `getWorkerConfig` garante timeout > intervalo ≥ 1s,
 * o timeout mínimo possível é 2s, e um piso de 1s continua seguro.
 *
 * Retorno falso significa que perdemos o lock: registramos e paramos de
 * renovar. Abortar no meio de uma submissão seria pior — o runner em andamento
 * ainda vai gravar seu resultado.
 */
function iniciarHeartbeat(
  service: SupabaseClient,
  kind: 'post' | 'comment',
  jobId: string,
  config: WorkerConfig,
) {
  const intervalo = Math.max(
    1_000,
    Math.floor((config.reaperTimeoutSeconds * 1000) / 3),
  )
  const timer = setInterval(() => {
    void (async () => {
      try {
        const { data } = await service.rpc('renew_job_lock', {
          p_kind: kind,
          p_job_id: jobId,
          p_worker_id: config.workerId,
        })
        if (data === false) {
          console.error(`worker: lock perdido em ${kind} ${jobId}`)
          clearInterval(timer)
        }
      } catch (e) {
        console.error('worker: heartbeat falhou', sanitize(e))
      }
    })()
  }, intervalo)

  // Não segura o processo aberto no desligamento.
  timer.unref?.()
  return { parar: () => clearInterval(timer) }
}

/**
 * Devolve à fila jobs reivindicados que não chegamos a processar.
 *
 * Seguro por construção: nenhum deles teve `submit_attempted_at` gravado — o
 * runner nem chegou a rodar. Ainda assim a condição está no `update`, para o
 * caso de a lista vir errada no futuro.
 */
async function devolverAFila(
  service: SupabaseClient,
  kind: 'post' | 'comment',
  ids: string[],
) {
  if (ids.length === 0) return
  const tabela = kind === 'post' ? 'scheduled_posts' : 'scheduled_comments'
  await service
    .from(tabela)
    .update({ status: 'scheduled', locked_at: null, locked_by: null })
    .in('id', ids)
    .eq('status', 'processing')
    .is('submit_attempted_at', null)
}

/**
 * Um ciclo completo. Exportado para ser testável sem subir o laço.
 */
export async function runCycle(
  opts: { dispatcher?: Dispatcher } = {},
): Promise<CycleReport> {
  const config = getWorkerConfig()
  const service = workerServiceClient()

  const relatorio: CycleReport = {
    reaped: 0,
    posts: {},
    comments: {},
    pausedForBudget: false,
  }

  // --- 1: reaper antes de tudo ---
  const { data: reaped } = await service.rpc('reap_stale_jobs', {
    p_timeout_seconds: config.reaperTimeoutSeconds,
  })
  relatorio.reaped = (reaped ?? []).length

  // --- 2: orçamento ANTES do claim ---
  //
  // A ordem importa e não é preferência de estilo. Se o claim viesse primeiro,
  // o worker esperaria o reset do orçamento segurando jobs em `processing`.
  // Passado o timeout, o reaper de outra instância os devolveria à fila e dois
  // workers processariam o mesmo job. Verificando antes, a situação não chega
  // a existir: sem orçamento, o ciclo termina sem ter reivindicado nada.
  const budget = await getBudgetWith(service)
  if (budget?.pausedUntil && budget.pausedUntil.getTime() > Date.now()) {
    relatorio.pausedForBudget = true
    return relatorio
  }

  // --- 3: publicações, uma por vez ---
  //
  // Sequencial de propósito. Paralelizar publicações da mesma conta furaria o
  // espaçamento, e paralelizar contas diferentes multiplicaria o consumo de
  // orçamento sem ganho real: o gargalo é o rate limit do Reddit, não a CPU.
  const { data: posts } = await service.rpc('claim_due_posts', {
    p_worker_id: config.workerId,
    p_batch: config.batchSize,
  })

  const restantes = [...((posts ?? []) as PostJob[])]
  while (restantes.length > 0) {
    if (parando) break
    const job = restantes.shift()!

    const heartbeat = iniciarHeartbeat(service, 'post', job.id, config)
    try {
      const { outcome } = await runPost(job, opts)
      relatorio.posts[outcome] = (relatorio.posts[outcome] ?? 0) + 1
    } catch (e) {
      // Um job problemático não pode derrubar o ciclo inteiro.
      console.error('worker: falha inesperada em publicação', sanitize(e))
      relatorio.posts.error = (relatorio.posts.error ?? 0) + 1
    } finally {
      heartbeat.parar()
    }

    // Orçamento esgotado no meio do lote: interrompe e DEVOLVE o que sobrou.
    // Segurar jobs reivindicados até o próximo ciclo é justamente o que a
    // ordem entre 2 e 3 existe para evitar.
    const agora = await getBudgetWith(service)
    if (agora?.pausedUntil && agora.pausedUntil.getTime() > Date.now()) {
      relatorio.pausedForBudget = true
      await devolverAFila(
        service,
        'post',
        restantes.map((j) => j.id),
      )
      break
    }
  }

  if (relatorio.pausedForBudget) return relatorio

  // --- 4: comentários ---
  const { data: comments } = await service.rpc('claim_due_comments', {
    p_worker_id: config.workerId,
    p_batch: config.batchSize,
  })

  const comRestantes = [...((comments ?? []) as CommentJob[])]
  while (comRestantes.length > 0) {
    if (parando) break
    const job = comRestantes.shift()!

    const heartbeat = iniciarHeartbeat(service, 'comment', job.id, config)
    try {
      const { outcome } = await runComment(job, opts)
      relatorio.comments[outcome] = (relatorio.comments[outcome] ?? 0) + 1
    } catch (e) {
      console.error('worker: falha inesperada em comentário', sanitize(e))
      relatorio.comments.error = (relatorio.comments.error ?? 0) + 1
    } finally {
      heartbeat.parar()
    }

    const agora = await getBudgetWith(service)
    if (agora?.pausedUntil && agora.pausedUntil.getTime() > Date.now()) {
      relatorio.pausedForBudget = true
      await devolverAFila(
        service,
        'comment',
        comRestantes.map((j) => j.id),
      )
      break
    }
  }

  return relatorio
}

async function limparLogsAntigos() {
  const { logRetentionDays } = getWorkerConfig()
  const corte = new Date(Date.now() - logRetentionDays * 86_400_000)
  const service = workerServiceClient()
  await service
    .from('execution_logs')
    .delete()
    .lt('created_at', corte.toISOString())
}

async function main() {
  const config = getWorkerConfig()

  // Conferido uma vez, na subida, e não a cada ciclo: sem as credenciais do
  // Reddit o worker não tem o que fazer, e repetir o mesmo erro a cada 30
  // segundos esconderia o problema em vez de anunciá-lo. O orçamento é
  // indexado pelo client_id, então nem a leitura de saldo funciona sem elas.
  try {
    getRedditEnv()
  } catch (e) {
    console.error(
      'worker: não é possível iniciar sem as credenciais do Reddit.\n' +
        (e as Error).message,
    )
    process.exit(1)
  }

  console.log(
    `worker ${config.workerId} iniciado: ciclo a cada ${config.intervalSeconds}s, ` +
      `lote de ${config.batchSize}, reaper em ${config.reaperTimeoutSeconds}s`,
  )
  console.log(
    `undici bundled: ${process.versions.undici} | instalado: ver package.json`,
  )

  // Desligamento gracioso: para de pegar jobs novos e deixa o atual terminar.
  for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sinal, () => {
      if (parando) process.exit(1)
      console.log(`worker: ${sinal} recebido, encerrando após o job atual…`)
      parando = true
    })
  }

  let ultimaLimpeza = 0

  while (!parando) {
    const inicio = Date.now()
    try {
      const r = await runCycle()
      if (
        r.reaped > 0 ||
        Object.keys(r.posts).length > 0 ||
        Object.keys(r.comments).length > 0
      ) {
        console.log('worker: ciclo', JSON.stringify(r))
      }
      if (r.pausedForBudget) {
        console.log('worker: orçamento do Reddit esgotado, aguardando reset')
      }
    } catch (e) {
      console.error('worker: ciclo falhou', sanitize(e))
    }

    if (Date.now() - ultimaLimpeza > 3_600_000) {
      try {
        await limparLogsAntigos()
        ultimaLimpeza = Date.now()
      } catch (e) {
        console.error('worker: limpeza de logs falhou', sanitize(e))
      }
    }

    // Desconta o tempo já gasto: o intervalo é entre inícios de ciclo.
    const restante = config.intervalSeconds * 1000 - (Date.now() - inicio)
    if (restante > 0 && !parando) await dormir(restante)
  }

  console.log('worker: encerrado.')
  process.exit(0)
}

// Só sobe o laço quando o arquivo é o ponto de entrada. Importar `runCycle`
// em um teste não pode iniciar o worker.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
