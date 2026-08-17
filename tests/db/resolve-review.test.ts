import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let conta: string
let sub: string

async function criarPost(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_id: sub,
      title: 'Publicação em revisão',
      url: 'https://exemplo.com/v',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() - 3600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
      status: 'needs_review',
      review_reason: 'OUTCOME_UNKNOWN',
      submit_attempted_at: new Date(Date.now() - 3500_000).toISOString(),
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function criarComentario(
  postId: string,
  overrides: Record<string, unknown> = {},
) {
  const { data, error } = await adminClient()
    .from('scheduled_comments')
    .insert({
      owner_id: userA.id,
      scheduled_post_id: postId,
      reddit_account_id: conta,
      body: 'comentário programado',
      mode: 'immediate',
      status: 'scheduled',
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

const resolver = (args: Record<string, unknown>) =>
  adminClient().rpc('resolve_needs_review', args)

const identificado = {
  p_reddit_post_id: 'abc123',
  p_reddit_fullname: 't3_abc123',
  p_permalink: 'https://www.reddit.com/r/x/comments/abc123/t/',
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`rr-a-${stamp}@teste.local`)
  userB = await createTestUser(`rr-b-${stamp}@teste.local`)

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_rr_${stamp}`,
      username: 'conta_revisao',
    })
    .select('id')
    .single()
  conta = c!.id as string

  const { data: s } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_fullname: `t5_rr_${stamp}`,
      name: 'com_revisao',
      display_name: 'Comunidade',
      url: '/r/com_revisao/',
    })
    .select('id')
    .single()
  sub = s!.id as string
})

beforeEach(async () => {
  await adminClient().from('scheduled_posts').delete().eq('owner_id', userA.id)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('resolve_needs_review — resolver como publicado', () => {
  it('grava id, fullname, permalink e published_at', async () => {
    const id = await criarPost()
    const { error } = await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'published',
      ...identificado,
    })
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('*')
      .eq('id', id)
      .single()
    expect(data!.status).toBe('published')
    expect(data!.reddit_post_id).toBe('abc123')
    expect(data!.reddit_fullname).toBe('t3_abc123')
    expect(data!.reddit_permalink).toContain('abc123')
    expect(data!.published_at).not.toBeNull()
  })

  it('registra resolved_by e resolved_at', async () => {
    const id = await criarPost()
    await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'published',
      ...identificado,
    })

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('resolved_by, resolved_at, review_reason')
      .eq('id', id)
      .single()
    expect(data!.resolved_by).toBe(userA.id)
    expect(data!.resolved_at).not.toBeNull()
    // O motivo da revisão sai: ela foi resolvida.
    expect(data!.review_reason).toBeNull()
  })

  it('RECUSA sem o identificador da publicação', async () => {
    // Sem ele o histórico mentiria e o comentário não teria onde ser feito.
    const id = await criarPost()
    const { error } = await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'published',
    })
    expect(error).not.toBeNull()
    expect((await lerStatus(id))).toBe('needs_review')
  })

  it('RECUSA com id mas sem fullname', async () => {
    const id = await criarPost()
    const { error } = await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'published',
      p_reddit_post_id: 'abc123',
    })
    expect(error).not.toBeNull()
  })

  it('materializa o horário dos comentários programados', async () => {
    const id = await criarPost()
    const com = await criarComentario(id)

    await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'published',
      ...identificado,
    })

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('status, scheduled_at')
      .eq('id', com)
      .single()
    expect(data!.status).toBe('scheduled')
    expect(data!.scheduled_at).not.toBeNull()
  })
})

describe('resolve_needs_review — resolver como falho ou cancelado', () => {
  it('cancela os comentários pendentes', async () => {
    // Sem publicação não há onde comentar; deixá-los pendentes seria esperar
    // para sempre por um post que não existe.
    const id = await criarPost()
    const com = await criarComentario(id)

    await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'failed',
    })

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('status')
      .eq('id', com)
      .single()
    expect(data!.status).toBe('cancelled')
  })

  it('não exige identificador', async () => {
    const id = await criarPost()
    const { error } = await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'failed',
    })
    expect(error).toBeNull()
    expect(await lerStatus(id)).toBe('failed')
  })

  it('cancelled também é um desfecho válido', async () => {
    const id = await criarPost()
    const { error } = await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'cancelled',
    })
    expect(error).toBeNull()
    expect(await lerStatus(id)).toBe('cancelled')
  })

  it('não mexe em comentário já publicado', async () => {
    const id = await criarPost()
    const com = await criarComentario(id, {
      status: 'published',
      mode: 'absolute',
      scheduled_at: new Date().toISOString(),
      reddit_comment_id: 'c1',
      published_at: new Date().toISOString(),
    })

    await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'failed',
    })

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('status')
      .eq('id', com)
      .single()
    expect(data!.status).toBe('published')
  })
})

describe('resolve_needs_review — o que ela recusa', () => {
  it('recusa decisão fora da lista', async () => {
    const id = await criarPost()
    for (const decisao of ['scheduled', 'processing', 'inventado', 'draft']) {
      const { error } = await resolver({
        p_owner_id: userA.id,
        p_post_id: id,
        p_decision: decisao,
        ...identificado,
      })
      expect(error, decisao).not.toBeNull()
    }
    expect(await lerStatus(id)).toBe('needs_review')
  })

  it('recusa post que NÃO está em needs_review', async () => {
    // A máquina de estados não pode ser contornada por esta porta.
    for (const status of ['scheduled', 'published', 'failed', 'cancelled']) {
      await adminClient()
        .from('scheduled_posts')
        .delete()
        .eq('owner_id', userA.id)
      const id = await criarPost({ status, review_reason: null })

      const { error } = await resolver({
        p_owner_id: userA.id,
        p_post_id: id,
        p_decision: 'failed',
      })
      expect(error, status).not.toBeNull()
    }
  })

  it('ISOLAMENTO: o dono B não resolve a publicação de A', async () => {
    const id = await criarPost()
    const { error } = await resolver({
      p_owner_id: userB.id,
      p_post_id: id,
      p_decision: 'published',
      ...identificado,
    })
    expect(error).not.toBeNull()
    expect(await lerStatus(id)).toBe('needs_review')

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('resolved_by')
      .eq('id', id)
      .single()
    expect(data!.resolved_by).toBeNull()
  })

  it('recusa owner nulo', async () => {
    const id = await criarPost()
    const { error } = await resolver({
      p_owner_id: null,
      p_post_id: id,
      p_decision: 'failed',
    })
    expect(error).not.toBeNull()
  })

  it('resolver duas vezes não é possível', async () => {
    // A segunda chamada já não encontra o post em needs_review.
    const id = await criarPost()
    await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'published',
      ...identificado,
    })
    const { error } = await resolver({
      p_owner_id: userA.id,
      p_post_id: id,
      p_decision: 'failed',
    })
    expect(error).not.toBeNull()
    expect(await lerStatus(id)).toBe('published')
  })
})

describe('resolve_needs_review — alcance', () => {
  it('anon e authenticated não têm EXECUTE', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, r.rolname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral (values ('anon'), ('authenticated')) as r(rolname)
         where n.nspname = 'public'
           and p.proname = 'resolve_needs_review'
           and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('a função existe, é SECURITY DEFINER e fixa search_path', async () => {
    // Sem isto, o teste acima passaria por ausência em vez de por proteção.
    const { rows } = await withSql((db) =>
      db.query(
        `select p.prosecdef, p.proconfig from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'resolve_needs_review'`,
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].prosecdef).toBe(true)
    expect(rows[0].proconfig).toContain('search_path=""')
  })

  it('service_role tem EXECUTE: senão a action não funciona', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'resolve_needs_review'
           and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(1)
  })
})

async function lerStatus(id: string) {
  const { data } = await adminClient()
    .from('scheduled_posts')
    .select('status')
    .eq('id', id)
    .single()
  return data!.status as string
}
