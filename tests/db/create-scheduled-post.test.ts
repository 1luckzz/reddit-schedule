// tests/db/create-scheduled-post.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string
let subB: string

async function criarConta(ownerId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_cf_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

async function criarSub(ownerId: string, contaId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_cf_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    reddit_account_id: contaA,
    subreddit_id: subA,
    title: 'Título',
    url: 'https://exemplo.com/v',
    body: null,
    post_kind: 'link',
    flair_id: null,
    nsfw: false,
    spoiler: false,
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
    timezone: 'America/Sao_Paulo',
    status: 'scheduled',
    ...overrides,
  }
}

async function criar(
  token: string,
  p: Record<string, unknown>,
  c: Record<string, unknown> | null = null,
) {
  return userClient(token).rpc('create_scheduled_post', {
    p_post: p,
    p_comment: c,
  })
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`cf-a-${stamp}@teste.local`)
  userB = await createTestUser(`cf-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaB = await criarConta(userB.id, `b${stamp}`)
  subA = await criarSub(userA.id, contaA, `a${stamp}`)
  subB = await criarSub(userB.id, contaB, `b${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('create_scheduled_post', () => {
  it('cria o post sozinho quando não há comentário', async () => {
    const { data, error } = await criar(userA.accessToken, post())
    expect(error).toBeNull()
    expect(data).toBeTruthy()

    const { data: linhas } = await adminClient()
      .from('scheduled_posts')
      .select('id, owner_id, status')
      .eq('id', data as string)
    expect(linhas).toHaveLength(1)
    expect(linhas![0].owner_id).toBe(userA.id)
  })

  it('cria post e comentário juntos', async () => {
    const { data: postId, error } = await criar(userA.accessToken, post(), {
      body: 'Comentário automático',
      mode: 'immediate',
    })
    expect(error).toBeNull()

    const { data: comentarios } = await adminClient()
      .from('scheduled_comments')
      .select('id, body, reddit_account_id, owner_id')
      .eq('scheduled_post_id', postId as string)
    expect(comentarios).toHaveLength(1)
    expect(comentarios![0].body).toBe('Comentário automático')
    // A conta do comentário é herdada do post, não recebida do cliente.
    expect(comentarios![0].reddit_account_id).toBe(contaA)
    expect(comentarios![0].owner_id).toBe(userA.id)
  })

  it('ATOMICIDADE: comentário inválido não deixa post órfão', async () => {
    const antes = await adminClient()
      .from('scheduled_posts')
      .select('id')
      .eq('owner_id', userA.id)

    // mode delay sem delay_minutes viola a CHECK constraint.
    const { error } = await criar(userA.accessToken, post(), {
      body: 'Comentário',
      mode: 'delay',
    })
    expect(error).not.toBeNull()

    const depois = await adminClient()
      .from('scheduled_posts')
      .select('id')
      .eq('owner_id', userA.id)
    expect(depois.data!.length).toBe(antes.data!.length)
  })

  it('ATOMICIDADE: post inválido não cria comentário', async () => {
    const antes = await adminClient()
      .from('scheduled_comments')
      .select('id')
      .eq('owner_id', userA.id)

    const { error } = await criar(
      userA.accessToken,
      post({ title: '   ' }),
      { body: 'Comentário', mode: 'immediate' },
    )
    expect(error).not.toBeNull()

    const depois = await adminClient()
      .from('scheduled_comments')
      .select('id')
      .eq('owner_id', userA.id)
    expect(depois.data!.length).toBe(antes.data!.length)
  })

  it('IDOR: o owner vem da sessão, não do payload', async () => {
    // Mesmo mandando o owner de B, a linha nasce como de A.
    const { data: postId, error } = await criar(
      userA.accessToken,
      post({ owner_id: userB.id }),
    )
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('owner_id')
      .eq('id', postId as string)
      .single()
    expect(data!.owner_id).toBe(userA.id)
  })

  it('IDOR: A não agenda usando a conta de B', async () => {
    const { error } = await criar(
      userA.accessToken,
      post({ reddit_account_id: contaB, subreddit_id: subB }),
    )
    expect(error).not.toBeNull()
  })

  it('IDOR: A não agenda em comunidade de B', async () => {
    const { error } = await criar(
      userA.accessToken,
      post({ subreddit_id: subB }),
    )
    expect(error).not.toBeNull()
  })

  it('recusa status inicial fora de draft e scheduled', async () => {
    const { error } = await criar(
      userA.accessToken,
      post({ status: 'published' }),
    )
    expect(error).not.toBeNull()
  })

  it('aceita rascunho', async () => {
    const { error } = await criar(userA.accessToken, post({ status: 'draft' }))
    expect(error).toBeNull()
  })

  it('a função não é chamável por anon', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'create_scheduled_post'
           and has_function_privilege('anon', p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })
})

describe('mutação direta pelo Data API é fechada', () => {
  // Se qualquer um destes passar a funcionar, o cliente ganha um caminho para
  // agendar sem passar por post_requirements, pela confirmação de link+texto
  // e pela validação de horário.

  it('authenticated tem apenas SELECT nas tabelas de agendamento', async () => {
    const { withSql } = await import('./sql')
    for (const tabela of ['scheduled_posts', 'scheduled_comments']) {
      const { rows } = await withSql((db) =>
        db.query(
          `select privilege_type from information_schema.role_table_grants
           where grantee = 'authenticated' and table_name = $1
           order by privilege_type`,
          [tabela],
        ),
      )
      expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
    }
  })

  it('authenticated não tem UPDATE em nenhuma coluna', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select column_name from information_schema.column_privileges
         where grantee = 'authenticated'
           and table_name in ('scheduled_posts', 'scheduled_comments')
           and privilege_type = 'UPDATE'`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('INSERT direto em scheduled_posts é recusado', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .insert({
        owner_id: userA.id,
        reddit_account_id: contaA,
        subreddit_id: subA,
        title: 'Contornando as regras',
        url: 'https://exemplo.com/x',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
      })
    expect(error).not.toBeNull()
  })

  it('INSERT direto em scheduled_comments é recusado', async () => {
    const { data: postId } = await criar(userA.accessToken, post())
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_comments')
      .insert({
        owner_id: userA.id,
        scheduled_post_id: postId as string,
        reddit_account_id: contaA,
        body: 'Comentário fora das regras',
        mode: 'immediate',
      })
    expect(error).not.toBeNull()
  })

  it('UPDATE direto de scheduled_at é recusado', async () => {
    const { data: postId } = await criar(userA.accessToken, post())
    const novo = new Date(Date.now() + 86_400_000).toISOString()

    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .update({ scheduled_at: novo })
      .eq('id', postId as string)
    expect(error).not.toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('scheduled_at')
      .eq('id', postId as string)
      .single()
    expect(data!.scheduled_at).not.toBe(novo)
  })

  it('UPDATE direto de status para cancelled é recusado', async () => {
    const { data: postId } = await criar(userA.accessToken, post())

    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .update({ status: 'cancelled' })
      .eq('id', postId as string)
    expect(error).not.toBeNull()
  })

  it('DELETE direto é recusado', async () => {
    const { data: postId } = await criar(userA.accessToken, post())
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .delete()
      .eq('id', postId as string)
    expect(error).not.toBeNull()
  })

  it('MAS a RPC de reagendamento funciona', async () => {
    const { data: postId } = await criar(userA.accessToken, post())
    const novo = new Date(Date.now() + 86_400_000).toISOString()

    const { error } = await userClient(userA.accessToken).rpc(
      'reschedule_scheduled_post',
      {
        p_post_id: postId as string,
        p_scheduled_at: novo,
        p_timezone: 'America/Sao_Paulo',
      },
    )
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('scheduled_at')
      .eq('id', postId as string)
      .single()
    expect(new Date(data!.scheduled_at).toISOString()).toBe(novo)
  })

  it('MAS a RPC de cancelamento funciona', async () => {
    const { data: postId } = await criar(userA.accessToken, post())

    const { error } = await userClient(userA.accessToken).rpc(
      'cancel_scheduled_post',
      { p_post_id: postId as string },
    )
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postId as string)
      .single()
    expect(data!.status).toBe('cancelled')
  })

  it('a RPC de reagendamento recusa post de outro usuário', async () => {
    const { data: postId } = await criar(userA.accessToken, post())

    const { error } = await userClient(userB.accessToken).rpc(
      'reschedule_scheduled_post',
      {
        p_post_id: postId as string,
        p_scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
        p_timezone: 'America/Sao_Paulo',
      },
    )
    expect(error).not.toBeNull()
  })

  it('a RPC de cancelamento recusa post de outro usuário', async () => {
    const { data: postId } = await criar(userA.accessToken, post())

    const { error } = await userClient(userB.accessToken).rpc(
      'cancel_scheduled_post',
      { p_post_id: postId as string },
    )
    expect(error).not.toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postId as string)
      .single()
    expect(data!.status).toBe('scheduled')
  })

  it('as RPCs de mutação não são chamáveis por anon', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'create_scheduled_post',
             'reschedule_scheduled_post',
             'cancel_scheduled_post'
           )
           and has_function_privilege('anon', p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('as RPCs têm search_path fixo', async () => {
    const { withSql } = await import('./sql')
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, p.proconfig from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'create_scheduled_post',
             'reschedule_scheduled_post',
             'cancel_scheduled_post'
           )`,
      ),
    )
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect((r.proconfig ?? []).join(',')).toContain('search_path=')
    }
  })
})
