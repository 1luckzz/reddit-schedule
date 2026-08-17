import { randomBytes } from 'node:crypto'

export type WorkerConfig = {
  workerId: string
  intervalSeconds: number
  batchSize: number
  reaperTimeoutSeconds: number
  logRetentionDays: number
}

function inteiro(nome: string, valor: string | undefined, padrao: number) {
  if (valor === undefined || valor === '') return padrao
  const n = Number(valor)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${nome} precisa ser um inteiro positivo. Recebido: ${valor}`,
    )
  }
  return n
}

export function getWorkerConfig(): WorkerConfig {
  const intervalSeconds = inteiro(
    'WORKER_INTERVAL_SECONDS',
    process.env.WORKER_INTERVAL_SECONDS,
    30,
  )
  const reaperTimeoutSeconds = inteiro(
    'WORKER_REAPER_TIMEOUT_SECONDS',
    process.env.WORKER_REAPER_TIMEOUT_SECONDS,
    600,
  )

  if (reaperTimeoutSeconds <= intervalSeconds) {
    // Um timeout menor que o intervalo mataria jobs que ainda estão rodando.
    throw new Error(
      'WORKER_REAPER_TIMEOUT_SECONDS precisa ser maior que WORKER_INTERVAL_SECONDS.',
    )
  }

  return {
    workerId:
      process.env.WORKER_ID || `worker-${randomBytes(4).toString('hex')}`,
    intervalSeconds,
    batchSize: inteiro('WORKER_BATCH_SIZE', process.env.WORKER_BATCH_SIZE, 10),
    reaperTimeoutSeconds,
    logRetentionDays: inteiro(
      'WORKER_LOG_RETENTION_DAYS',
      process.env.WORKER_LOG_RETENTION_DAYS,
      30,
    ),
  }
}
