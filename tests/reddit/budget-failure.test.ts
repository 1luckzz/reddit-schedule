import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockAgent } from 'undici'

/**
 * Cenário: o mecanismo de orçamento está indisponível.
 *
 * A regra é fail-closed — sem conseguir reservar capacidade, a requisição ao
 * Reddit não sai. Deixar passar transformaria uma falha do nosso controle em
 * tráfego não contabilizado contra o limite da aplicação.
 *
 * Estes testes substituem o client administrativo, então não tocam no banco e
 * rodam também no CI.
 */

const rpc = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => ({ rpc }),
}))

beforeEach(() => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  rpc.mockReset()
})

describe('orçamento indisponível — fail-closed', () => {
  it('erro devolvido pela RPC impede a reserva', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } })

    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).rejects.toMatchObject({
      code: 'BUDGET_UNAVAILABLE',
      disposition: 'retryable',
    })
  })

  it('exceção ao chamar a RPC impede a reserva', async () => {
    rpc.mockRejectedValue(new Error('socket hang up'))

    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).rejects.toMatchObject({
      code: 'BUDGET_UNAVAILABLE',
    })
  })

  it('resposta vazia da RPC é tratada como indisponibilidade, não permissão', async () => {
    rpc.mockResolvedValue({ data: null, error: null })

    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).rejects.toMatchObject({
      code: 'BUDGET_UNAVAILABLE',
    })
  })

  it('a mensagem diz que não foi possível verificar, sem prometer limite atingido', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } })

    const { reserveBudget } = await import('@/lib/reddit/budget')
    try {
      await reserveBudget()
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/não foi possível verificar/i)
      expect(msg).not.toMatch(/limite de requisições ao Reddit foi atingido/i)
    }
  })

  it('o erro é retryable: a indisponibilidade é temporária', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } })

    const { reserveBudget } = await import('@/lib/reddit/budget')
    try {
      await reserveBudget()
      throw new Error('deveria ter lançado')
    } catch (e) {
      const erro = e as { disposition: string; retryAfterSeconds?: number }
      expect(erro.disposition).toBe('retryable')
      expect(erro.retryAfterSeconds).toBeGreaterThan(0)
    }
  })

  it('DISTINÇÃO: remaining desconhecido continua sendo reserva otimista', async () => {
    // O mecanismo respondeu e autorizou; apenas ainda não sabemos o saldo.
    // Isto NÃO é indisponibilidade e não deve bloquear.
    rpc.mockResolvedValue({
      data: [{ allowed: true, remaining: null, paused_until: null }],
      error: null,
    })

    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).resolves.toBeUndefined()
  })

  it('DISTINÇÃO: orçamento esgotado tem código próprio, diferente de indisponível', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          allowed: false,
          remaining: 2,
          paused_until: new Date(Date.now() + 120_000).toISOString(),
        },
      ],
      error: null,
    })

    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    })
  })

  it('a requisição ao Reddit NÃO é emitida quando a reserva falha', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'banco fora' } })

    const agent = new MockAgent()
    agent.disableNetConnect()
    // Nenhum intercept registrado: qualquer requisição emitida falharia o
    // teste com erro de conexão, em vez do erro de orçamento.

    const { reserveBudget } = await import('@/lib/reddit/budget')
    const { createRedditClient } = await import('@/lib/reddit/client')

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest: reserveBudget,
    })

    await expect(client.request({ path: '/api/v1/me' })).rejects.toMatchObject({
      code: 'BUDGET_UNAVAILABLE',
    })

    await agent.close()
  })

  it('nenhuma reserva pendente fica para trás quando a reserva falha', async () => {
    // Reserva negada não chegou a incrementar o contador, então também não
    // deve ser devolvida — senão o saldo em voo ficaria negativo.
    rpc.mockResolvedValue({ data: null, error: { message: 'banco fora' } })

    const agent = new MockAgent()
    agent.disableNetConnect()
    const onAfterRequest = vi.fn()

    const { reserveBudget } = await import('@/lib/reddit/budget')
    const { createRedditClient } = await import('@/lib/reddit/client')

    const client = createRedditClient({
      accessToken: 'AT',
      dispatcher: agent,
      onBeforeRequest: reserveBudget,
      onAfterRequest,
    })

    await client.request({ path: '/api/v1/me' }).catch(() => {})
    expect(onAfterRequest).not.toHaveBeenCalled()

    await agent.close()
  })
})
