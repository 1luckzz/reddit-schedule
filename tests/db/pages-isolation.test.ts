import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient,
  cleanupTestUsers,
  createTestUser,
  userClient,
} from './helpers'

// ---------------------------------------------------------------
// Isolamento A/B das consultas que as páginas do Plano 5 fazem
// ---------------------------------------------------------------
// Os testes de estrutura conferem que as páginas usam o client do usuário e
// não filtram por owner à mão. Este arquivo prova a consequência: com a RLS
// no comando, a MESMA consulta devolve conjuntos diferentes para donos
// diferentes — e nunca vaza uma linha de um para o outro.

type Usuario = { id: string; accessToken: string }
type Cenario = { conta: string; sub: string; posts: Record<string, string> }

let userA: Usuario
let userB: Usuario
let cenarioA: Cenario
let cenarioB: Cenario

async function montar(user: Usuario, prefixo: string): Promise<Cenario> {
  const stamp = `${prefixo}_${Date.now()}`

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: user.id,
      reddit_user_id: `t2_${stamp}`,
      username: `conta_${prefixo}`,
    })
    .select('id')
    .single()
  const conta = c!.id as string

  const { data: s } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: user.id,
      reddit_account_id: conta,
      subreddit_fullname: `t5_${stamp}`,
      name: `com_${prefixo}`,
      display_name: 'Comunidade',
      url: `/r/com_${prefixo}/`,
    })
    .select('id')
    .single()
  const sub = s!.id as string

  const posts: Record<string, string> = {}
  const estados: [string, Record<string, unknown>][] = [
    ['scheduled', { scheduled_at: new Date(Date.now() + 3600_000).toISOString() }],
    [
      'needs_review',
      {
        review_reason: 'OUTCOME_UNKNOWN',
        submit_attempted_at: new Date().toISOString(),
      },
    ],
    [
      'published',
      {
        reddit_post_id: `p_${stamp}`,
        reddit_fullname: `t3_${stamp}`,
        reddit_permalink: `https://www.reddit.com/r/x/${stamp}/`,
        published_at: new Date().toISOString(),
      },
    ],
    ['failed', { error_message: 'O Reddit recusou os dados enviados.' }],
  ]

  for (const [status, extra] of estados) {
    const { data, error } = await adminClient()
      .from('scheduled_posts')
      .insert({
        owner_id: user.id,
        reddit_account_id: conta,
        subreddit_id: sub,
        title: `Título de ${prefixo}`,
        url: 'https://exemplo.com/v',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() - 60_000).toISOString(),
        timezone: 'America/Sao_Paulo',
        status,
        ...extra,
      })
      .select('id')
      .single()
    if (error) throw error
    posts[status] = data!.id as string
  }

  await adminClient().from('execution_logs').insert({
    owner_id: user.id,
    reddit_account_id: conta,
    scheduled_post_id: posts.published,
    action: 'submit_post',
    outcome: 'success',
    http_status: 200,
  })

  return { conta, sub, posts }
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`pi-a-${stamp}@teste.local`)
  userB = await createTestUser(`pi-b-${stamp}@teste.local`)
  cenarioA = await montar(userA, 'pia')
  cenarioB = await montar(userB, 'pib')
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

/**
 * Executa a consulta e falha alto se ela errar.
 *
 * Sem isto, uma consulta quebrada devolveria `data: null` e as asserções de
 * isolamento passariam por vacuidade: "A não vê a linha de B" é trivialmente
 * verdadeiro quando a consulta não devolve nada. Foi assim que a junção
 * ambígua com `subreddits` quase passou despercebida.
 */
async function linhas<T>(consulta: PromiseLike<{ data: T[] | null; error: unknown }>) {
  const { data, error } = await consulta
  if (error) throw new Error(`consulta falhou: ${JSON.stringify(error)}`)
  if (data === null) throw new Error('consulta devolveu null sem erro')
  return data
}

/** A consulta da página de Revisão, palavra por palavra. */
const consultaRevisao = (token: string) =>
  userClient(token)
    .from('scheduled_posts')
    .select(
      `id, title, review_reason, submit_attempted_at, scheduled_at, timezone,
       reddit_accounts ( username ),
       subreddits!scheduled_posts_subreddit_id_owner_id_fkey ( name )`,
    )
    .eq('status', 'needs_review')

/** A consulta da página de Fila. */
const consultaFila = (token: string) =>
  userClient(token)
    .from('scheduled_posts')
    .select(
      `id, title, status, scheduled_at, timezone,
       reddit_accounts ( username ),
       subreddits!scheduled_posts_subreddit_id_owner_id_fkey ( name )`,
    )
    .in('status', ['draft', 'scheduled', 'processing', 'needs_review'])

/** A consulta da página de Histórico. */
const consultaHistorico = (token: string) =>
  userClient(token)
    .from('scheduled_posts')
    .select('id, title, status, reddit_permalink, error_message')
    .in('status', ['published', 'failed', 'cancelled'])

describe('página de Revisão', () => {
  it('A vê a própria publicação em revisão', async () => {
    const data = await linhas(consultaRevisao(userA.accessToken))
    expect(data.map((r) => r.id)).toContain(cenarioA.posts.needs_review)
  })

  it('A NÃO vê a publicação em revisão de B', async () => {
    const data = await linhas(consultaRevisao(userA.accessToken))
    expect(data.map((r) => r.id)).not.toContain(cenarioB.posts.needs_review)
  })

  it('a junção com contas e comunidades também respeita a RLS', async () => {
    // Um join mal configurado vazaria o username da conta do outro dono.
    const data = await linhas(consultaRevisao(userA.accessToken))
    for (const linha of data) {
      const conta = linha.reddit_accounts as unknown as {
        username: string
      } | null
      expect(conta?.username).not.toBe('conta_pib')
    }
  })
})

describe('página de Fila', () => {
  it('cada dono vê só as próprias linhas', async () => {
    const deA = await linhas(consultaFila(userA.accessToken))
    const deB = await linhas(consultaFila(userB.accessToken))

    const idsA = new Set(deA.map((r) => r.id))
    const idsB = new Set(deB.map((r) => r.id))

    expect(idsA.has(cenarioA.posts.scheduled)).toBe(true)
    expect(idsB.has(cenarioB.posts.scheduled)).toBe(true)
    expect([...idsA].some((id) => idsB.has(id))).toBe(false)
  })

  it('filtrar pela conta de OUTRO dono não devolve nada', async () => {
    // Mesmo passando um id válido de B, a RLS não entrega as linhas dele.
    const data = await linhas(
      consultaFila(userA.accessToken).eq('reddit_account_id', cenarioB.conta),
    )
    expect(data).toEqual([])
  })

  it('filtrar pela comunidade de OUTRO dono não devolve nada', async () => {
    const data = await linhas(
      consultaFila(userA.accessToken).eq('subreddit_id', cenarioB.sub),
    )
    expect(data).toEqual([])
  })
})

describe('página de Histórico', () => {
  it('mostra os terminais do próprio dono', async () => {
    const data = await linhas(consultaHistorico(userA.accessToken))
    const ids = data.map((r) => r.id)
    expect(ids).toContain(cenarioA.posts.published)
    expect(ids).toContain(cenarioA.posts.failed)
  })

  it('não mostra os terminais de outro dono', async () => {
    const data = await linhas(consultaHistorico(userA.accessToken))
    const ids = data.map((r) => r.id)
    expect(ids).not.toContain(cenarioB.posts.published)
    expect(ids).not.toContain(cenarioB.posts.failed)
  })

  it('o permalink de B nunca aparece para A', async () => {
    const data = await linhas(consultaHistorico(userA.accessToken))
    for (const linha of data) {
      expect(linha.reddit_permalink ?? '').not.toContain('pib')
    }
  })
})

describe('página de Logs', () => {
  it('cada dono vê apenas os próprios registros', async () => {
    const deA = await linhas(
      userClient(userA.accessToken)
        .from('execution_logs')
        .select('id, scheduled_post_id'),
    )
    const deB = await linhas(
      userClient(userB.accessToken)
        .from('execution_logs')
        .select('id, scheduled_post_id'),
    )

    expect(deA.length).toBeGreaterThan(0)
    expect(deB.length).toBeGreaterThan(0)
    expect(deA.map((r) => r.scheduled_post_id)).not.toContain(
      cenarioB.posts.published,
    )
  })
})

describe('página de Calendário', () => {
  it('a janela por data não contorna a RLS', async () => {
    const inicio = new Date(Date.now() - 86_400_000).toISOString()
    const fim = new Date(Date.now() + 86_400_000).toISOString()

    const data = await linhas(
      userClient(userA.accessToken)
        .from('scheduled_posts')
        .select('id')
        .gte('scheduled_at', inicio)
        .lte('scheduled_at', fim),
    )

    const ids = data.map((r) => r.id)
    for (const id of Object.values(cenarioB.posts)) {
      expect(ids).not.toContain(id)
    }
  })
})

describe('Dashboard', () => {
  it('os contadores contam apenas o que é do dono', async () => {
    const contar = (token: string, status: string) =>
      userClient(token)
        .from('scheduled_posts')
        .select('id', { count: 'exact', head: true })
        .eq('status', status)

    const { count: a } = await contar(userA.accessToken, 'needs_review')
    const { count: b } = await contar(userB.accessToken, 'needs_review')

    // Cada um montou exatamente um item em revisão. Se o count ignorasse a
    // RLS, ambos veriam dois.
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('o perfil lido é o do próprio usuário', async () => {
    const data = await linhas(
      userClient(userA.accessToken).from('profiles').select('id, timezone'),
    )
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(userA.id)
  })
})
