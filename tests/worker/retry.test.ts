import { describe, expect, it } from 'vitest'
import { MAX_RETRIES, nextAttemptAt } from '@/lib/worker/retry'

describe('nextAttemptAt', () => {
  it('a primeira retentativa espera cerca de 1 minuto', () => {
    const d = nextAttemptAt(0)
    const espera = (d.getTime() - Date.now()) / 1000
    expect(espera).toBeGreaterThan(50)
    expect(espera).toBeLessThan(70)
  })

  it('o intervalo cresce a cada tentativa', () => {
    const a = nextAttemptAt(0).getTime()
    const b = nextAttemptAt(1).getTime()
    const c = nextAttemptAt(2).getTime()
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  it('respeita Retry-After quando é maior que o backoff', () => {
    const d = nextAttemptAt(0, 600)
    const espera = (d.getTime() - Date.now()) / 1000
    expect(espera).toBeGreaterThan(590)
  })

  it('ignora Retry-After menor que o backoff: não acelera a retentativa', () => {
    // Deixar o Reddit encurtar a espera que nós mesmos impusemos seria
    // exatamente o comportamento abusivo que a spec proíbe.
    const d = nextAttemptAt(2, 5)
    const espera = (d.getTime() - Date.now()) / 1000
    expect(espera).toBeGreaterThan(60)
  })

  it('não cresce indefinidamente além da tabela', () => {
    const ultimo = nextAttemptAt(2).getTime()
    const alem = nextAttemptAt(99).getTime()
    expect(Math.abs(alem - ultimo)).toBeLessThan(2000)
  })

  it('MAX_RETRIES é pequeno: retentar demais é abusivo', () => {
    expect(MAX_RETRIES).toBeLessThanOrEqual(3)
  })
})
