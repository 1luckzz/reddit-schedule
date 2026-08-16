import { beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { adminClient } from './helpers'
import { withSql } from './sql'

// O orçamento é global por client_id, e o Vitest roda arquivos em paralelo.
// Cada arquivo precisa do seu próprio client_id — e só pode apagar a própria
// linha, senão zera o orçamento que outro arquivo acabou de semear.
const CLIENT_ID = 'cid-suite-budget'
const HASH = createHash('sha256').update(CLIENT_ID).digest('hex')

beforeEach(async () => {
  process.env.REDDIT_CLIENT_ID = CLIENT_ID
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'
  await adminClient()
    .from('reddit_api_budget')
    .delete()
    .eq('client_id_hash', HASH)
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
      .eq('client_id_hash', HASH)
      .single()
    expect(data!.client_id_hash).not.toContain(CLIENT_ID)
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

describe('bootstrap: orçamento ainda desconhecido', () => {
  it('a primeira reserva sai normalmente', async () => {
    const { reserveBudget } = await import('@/lib/reddit/budget')
    await expect(reserveBudget()).resolves.toBeUndefined()
  })

  it('CORRIDA: com saldo desconhecido, apenas 1 reserva é aceita', async () => {
    // Quota desconhecida não pode virar concorrência ilimitada: uma requisição
    // sai para descobrir o limite, as demais esperam por ela.
    const { reserveBudget, getBudget } = await import('@/lib/reddit/budget')

    const tentativas = await Promise.allSettled(
      Array.from({ length: 8 }, () => reserveBudget()),
    )

    const aceitas = tentativas.filter((r) => r.status === 'fulfilled')
    expect(aceitas).toHaveLength(1)
    expect(tentativas.filter((r) => r.status === 'rejected')).toHaveLength(7)
    expect((await getBudget())!.reserved).toBe(1)
  })

  it('as recusadas identificam o motivo como bootstrap, não limite atingido', async () => {
    const { reserveBudget } = await import('@/lib/reddit/budget')
    await reserveBudget()

    await expect(reserveBudget()).rejects.toMatchObject({
      code: 'BUDGET_BOOTSTRAP',
      disposition: 'retryable',
    })
  })

  it('a mensagem de bootstrap não afirma que o limite foi atingido', async () => {
    const { reserveBudget } = await import('@/lib/reddit/budget')
    await reserveBudget()

    try {
      await reserveBudget()
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as { userMessage: string }).userMessage
      expect(msg).toMatch(/verificando|instantes|segundos/i)
      expect(msg).not.toMatch(/limite de requisições ao Reddit foi atingido/i)
    }
  })

  it('depois dos headers, a concorrência passa a seguir o remaining conhecido', async () => {
    const { reserveBudget, reconcileBudget, BUDGET_THRESHOLD } = await import(
      '@/lib/reddit/budget'
    )

    // Primeira chamada: sai no bootstrap e volta com os headers.
    await reserveBudget()
    await reconcileBudget({
      used: 10,
      remaining: BUDGET_THRESHOLD + 4,
      resetSeconds: 300,
    })

    // Agora o saldo é conhecido: cabem 4 reservas simultâneas, não 1.
    const tentativas = await Promise.allSettled(
      Array.from({ length: 8 }, () => reserveBudget()),
    )
    expect(tentativas.filter((r) => r.status === 'fulfilled')).toHaveLength(4)
  })

  it('falha sem headers libera a reserva e permite nova tentativa', async () => {
    const { reserveBudget, reconcileBudget, getBudget } = await import(
      '@/lib/reddit/budget'
    )

    await reserveBudget()
    // A requisição falhou sem resposta legível: devolve a reserva sem gravar
    // números que não temos.
    await reconcileBudget(null)

    const budget = await getBudget()
    expect(budget!.reserved).toBe(0)
    expect(budget!.remaining).toBeNull()

    // E o sistema continua em bootstrap, aceitando a próxima tentativa.
    await expect(reserveBudget()).resolves.toBeUndefined()
  })
})

describe('reserva atômica', () => {

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

    await adminClient().from('reddit_api_budget').upsert({
      client_id_hash: HASH,
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
