import { beforeEach, describe, expect, it } from 'vitest'
import { adminClient } from './helpers'
import { withSql } from './sql'

beforeEach(async () => {
  process.env.REDDIT_CLIENT_ID = 'cid-fake-budget'
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  await adminClient().from('reddit_api_budget').delete().neq('client_id_hash', '')
})

async function semearOrcamento(remaining: number, resetSeconds = 300) {
  const { reserveBudget, reconcileBudget } = await import('@/lib/reddit/budget')
  // Uma reserva seguida de reconciliação deixa reserved = 0 e os números do
  // Reddit gravados, que é o estado normal entre requisições.
  await reserveBudget()
  await reconcileBudget({ used: 100 - remaining, remaining, resetSeconds })
}

describe('reconciliação do orçamento', () => {
  it('grava o snapshot vindo dos headers', async () => {
    const { getBudget } = await import('@/lib/reddit/budget')
    await semearOrcamento(90)

    const budget = await getBudget()
    expect(budget!.remaining).toBe(90)
    expect(budget!.used).toBe(10)
    expect(budget!.resetAt!.getTime()).toBeGreaterThan(Date.now())
    expect(budget!.reserved).toBe(0)
  })

  it('não guarda o client_id em claro, apenas o hash', async () => {
    await semearOrcamento(99)

    const { data } = await adminClient()
      .from('reddit_api_budget')
      .select('client_id_hash')
      .single()
    expect(data!.client_id_hash).not.toContain('cid-fake-budget')
    expect(data!.client_id_hash).toHaveLength(64)
  })

  it('snapshot nulo libera a reserva sem apagar os números conhecidos', async () => {
    const { reserveBudget, reconcileBudget, getBudget } = await import(
      '@/lib/reddit/budget'
    )
    await semearOrcamento(90)

    await reserveBudget()
    expect((await getBudget())!.reserved).toBe(1)

    await reconcileBudget(null)
    const budget = await getBudget()
    expect(budget!.remaining).toBe(90)
    expect(budget!.reserved).toBe(0)
  })

  it('pausa quando o restante fica abaixo do limiar', async () => {
    const { getBudget, BUDGET_THRESHOLD } = await import('@/lib/reddit/budget')
    await semearOrcamento(BUDGET_THRESHOLD - 1, 120)

    const budget = await getBudget()
    expect(budget!.pausedUntil).not.toBeNull()
    expect(budget!.pausedUntil!.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('reserva atômica', () => {
  it('sem orçamento conhecido, a reserva é permitida', async () => {
    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).resolves.toBeUndefined()
  })

  it('cada reserva incrementa o contador de requisições em voo', async () => {
    const { reserveBudget, getBudget } = await import('@/lib/reddit/budget')
    await semearOrcamento(90)

    await reserveBudget()
    await reserveBudget()
    expect((await getBudget())!.reserved).toBe(2)
  })

  it('recusa enquanto a pausa vale', async () => {
    const { reserveBudget, BUDGET_THRESHOLD } = await import('@/lib/reddit/budget')
    await semearOrcamento(BUDGET_THRESHOLD - 1)

    await expect(reserveBudget()).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      disposition: 'retryable',
    })
  })

  it('volta a permitir quando a janela expira', async () => {
    const { reserveBudget, getBudget } = await import('@/lib/reddit/budget')
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update('cid-fake-budget').digest('hex')

    await adminClient().from('reddit_api_budget').upsert({
      client_id_hash: hash,
      used: 100,
      remaining: 0,
      reserved: 5,
      reset_at: new Date(Date.now() - 1000).toISOString(),
      paused_until: new Date(Date.now() - 1000).toISOString(),
    })

    await expect(reserveBudget()).resolves.toBeUndefined()

    // A janela encerrada zera as reservas em voo antes de contar a nova.
    const budget = await getBudget()
    expect(budget!.reserved).toBe(1)
  })

  it('CORRIDA: reservas concorrentes não excedem a capacidade', async () => {
    // Este é o teste que justifica a função SQL. Com remaining = threshold + 3,
    // cabem exatamente 3 reservas; as demais precisam ser recusadas mesmo
    // disparadas todas ao mesmo tempo.
    const { reserveBudget, getBudget, BUDGET_THRESHOLD } = await import(
      '@/lib/reddit/budget'
    )
    const capacidade = 3
    await semearOrcamento(BUDGET_THRESHOLD + capacidade)

    const tentativas = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveBudget()),
    )

    const aceitas = tentativas.filter((r) => r.status === 'fulfilled').length
    const recusadas = tentativas.filter((r) => r.status === 'rejected').length

    expect(aceitas).toBe(capacidade)
    expect(recusadas).toBe(10 - capacidade)
    expect((await getBudget())!.reserved).toBe(capacidade)
  })

  it('CORRIDA: o contador em voo nunca fica negativo', async () => {
    const { reconcileBudget, getBudget } = await import('@/lib/reddit/budget')
    await semearOrcamento(90)

    // Mais reconciliações que reservas: o contador satura em zero.
    await Promise.all([
      reconcileBudget(null),
      reconcileBudget(null),
      reconcileBudget(null),
    ])
    expect((await getBudget())!.reserved).toBe(0)
  })

  it('a mensagem de orçamento esgotado é legível e sem jargão', async () => {
    const { reserveBudget, BUDGET_THRESHOLD } = await import('@/lib/reddit/budget')
    await semearOrcamento(BUDGET_THRESHOLD - 1)

    try {
      await reserveBudget()
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/limite|aguard/i)
      expect(msg).not.toMatch(/undefined|null|hash/)
    }
  })

  it('as funções de orçamento não são chamáveis por anon nem authenticated', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, r.rolname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral (values ('anon'), ('authenticated')) as r(rolname)
         where n.nspname = 'public'
           and p.proname in ('reserve_api_budget', 'reconcile_api_budget')
           and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('o cliente não alcança a tabela pelo Data API', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select privilege_type from information_schema.role_table_grants
         where grantee in ('anon','authenticated')
           and table_name = 'reddit_api_budget'`,
      ),
    )
    expect(rows).toHaveLength(0)
  })
})
