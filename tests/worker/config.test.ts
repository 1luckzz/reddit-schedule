import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CHAVES = [
  'WORKER_ID',
  'WORKER_INTERVAL_SECONDS',
  'WORKER_BATCH_SIZE',
  'WORKER_REAPER_TIMEOUT_SECONDS',
  'WORKER_LOG_RETENTION_DAYS',
] as const

let original: Record<string, string | undefined>

beforeEach(() => {
  original = Object.fromEntries(CHAVES.map((k) => [k, process.env[k]]))
  for (const k of CHAVES) delete process.env[k]
})

afterEach(() => {
  for (const k of CHAVES) {
    if (original[k] === undefined) delete process.env[k]
    else process.env[k] = original[k]
  }
})

async function config() {
  const { getWorkerConfig } = await import('@/lib/worker/config')
  return getWorkerConfig()
}

describe('getWorkerConfig', () => {
  it('tem padrões utilizáveis sem nenhuma variável definida', async () => {
    const c = await config()
    expect(c.intervalSeconds).toBeGreaterThan(0)
    expect(c.batchSize).toBeGreaterThan(0)
    expect(c.reaperTimeoutSeconds).toBeGreaterThanOrEqual(300)
    expect(c.logRetentionDays).toBeGreaterThan(0)
  })

  it('gera um workerId único quando não informado', async () => {
    const a = await config()
    const b = await config()
    expect(a.workerId).not.toBe(b.workerId)
  })

  it('respeita WORKER_ID quando informado', async () => {
    process.env.WORKER_ID = 'worker-fixo'
    expect((await config()).workerId).toBe('worker-fixo')
  })

  it('lê os valores do ambiente', async () => {
    process.env.WORKER_INTERVAL_SECONDS = '15'
    process.env.WORKER_BATCH_SIZE = '3'
    process.env.WORKER_REAPER_TIMEOUT_SECONDS = '900'
    process.env.WORKER_LOG_RETENTION_DAYS = '7'

    const c = await config()
    expect(c.intervalSeconds).toBe(15)
    expect(c.batchSize).toBe(3)
    expect(c.reaperTimeoutSeconds).toBe(900)
    expect(c.logRetentionDays).toBe(7)
  })

  it('recusa valores não inteiros ou não positivos', async () => {
    for (const valor of ['0', '-5', 'abc', '1.5']) {
      process.env.WORKER_BATCH_SIZE = valor
      await expect(config(), `valor ${valor}`).rejects.toThrow()
    }
  })

  it('o timeout do reaper é maior que o intervalo, para não matar job vivo', async () => {
    const c = await config()
    expect(c.reaperTimeoutSeconds).toBeGreaterThan(c.intervalSeconds)
  })

  it('recusa configuração em que o reaper mataria jobs em execução', async () => {
    process.env.WORKER_INTERVAL_SECONDS = '600'
    process.env.WORKER_REAPER_TIMEOUT_SECONDS = '60'
    await expect(config()).rejects.toThrow(
      /WORKER_REAPER_TIMEOUT_SECONDS precisa ser maior/,
    )
  })
})
