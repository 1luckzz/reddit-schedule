import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

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

/**
 * Simula o que a server action faz: usa o client de service_role e passa o
 * owner já verificado. É o único caminho autorizado.
 */
async function criarPeloBackend(
  ownerId: string,
  p: Record<string, unknown>,
  c: Record<string, unknown> | null = null,
) {
  return adminClient().rpc('create_scheduled_post', {
    p_owner_id: ownerId,
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

describe('as RPCs de mutação são exclusivas do backend', () => {
  // post_requirements exige chamada externa ao Reddit e não pode ser
  // reproduzido em SQL. Se o cliente pudesse chamar estas funções direto,
  // agendaria sem essa validação.

  it('CATÁLOGO: anon e authenticated não têm EXECUTE em nenhuma delas', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, r.rolname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral (values ('anon'), ('authenticated')) as r(rolname)
         where n.nspname = 'public'
           and p.proname in (
             'create_scheduled_post',
             'reschedule_scheduled_post',
             'cancel_scheduled_post'
           )
           and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('CATÁLOGO: service_role tem EXECUTE nas três', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'create_scheduled_post',
             'reschedule_scheduled_post',
             'cancel_scheduled_post'
           )
           and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      ),
    )
    expect(rows).toHaveLength(3)
  })

  it('CATÁLOGO: as três são SECURITY DEFINER com search_path fixo', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p
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
      expect(r.prosecdef).toBe(true)
      expect((r.proconfig ?? []).join(',')).toContain('search_path=')
    }
  })

  it('CHAMADA DIRETA: usuário autenticado não cria pela RPC', async () => {
    const { error } = await userClient(userA.accessToken).rpc(
      'create_scheduled_post',
      { p_owner_id: userA.id, p_post: post(), p_comment: null },
    )
    expect(error).not.toBeNull()
  })

  it('CHAMADA DIRETA: usuário autenticado não reagenda pela RPC', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post())

    const { error } = await userClient(userA.accessToken).rpc(
      'reschedule_scheduled_post',
      {
        p_owner_id: userA.id,
        p_post_id: postId as string,
        p_scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
        p_timezone: 'America/Sao_Paulo',
      },
    )
    expect(error).not.toBeNull()
  })

  it('CHAMADA DIRETA: usuário autenticado não cancela pela RPC', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post())

    const { error } = await userClient(userA.accessToken).rpc(
      'cancel_scheduled_post',
      { p_owner_id: userA.id, p_post_id: postId as string },
    )
    expect(error).not.toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postId as string)
      .single()
    expect(data!.status).toBe('scheduled')
  })

  it('BACKEND: o caminho autorizado funciona', async () => {
    const { data, error } = await criarPeloBackend(userA.id, post())
    expect(error).toBeNull()
    expect(data).toBeTruthy()

    const { data: linhas } = await adminClient()
      .from('scheduled_posts')
      .select('owner_id')
      .eq('id', data as string)
      .single()
    expect(linhas!.owner_id).toBe(userA.id)
  })
})

describe('create_scheduled_post', () => {
  it('cria post e comentário juntos', async () => {
    const { data: postId, error } = await criarPeloBackend(userA.id, post(), {
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
    const { error } = await criarPeloBackend(userA.id, post(), {
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

    const { error } = await criarPeloBackend(userA.id, post({ title: '   ' }), {
      body: 'Comentário',
      mode: 'immediate',
    })
    expect(error).not.toBeNull()

    const depois = await adminClient()
      .from('scheduled_comments')
      .select('id')
      .eq('owner_id', userA.id)
    expect(depois.data!.length).toBe(antes.data!.length)
  })

  it('o owner_id do payload é ignorado: vale o parâmetro verificado', async () => {
    const { data: postId, error } = await criarPeloBackend(
      userA.id,
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

  it('recusa owner que não existe', async () => {
    const { error } = await criarPeloBackend(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      post(),
    )
    expect(error).not.toBeNull()
  })

  it('recusa conta que não é do owner informado', async () => {
    const { error } = await criarPeloBackend(
      userA.id,
      post({ reddit_account_id: contaB, subreddit_id: subB }),
    )
    expect(error).not.toBeNull()
  })

  it('recusa comunidade que não é do owner informado', async () => {
    const { error } = await criarPeloBackend(userA.id, post({ subreddit_id: subB }))
    expect(error).not.toBeNull()
  })

  it('recusa comunidade que não pertence à conta escolhida', async () => {
    const outraConta = await criarConta(userA.id, `o${Date.now()}`)
    const subOutra = await criarSub(userA.id, outraConta, `o${Date.now()}`)
    const { error } = await criarPeloBackend(
      userA.id,
      post({ subreddit_id: subOutra }),
    )
    expect(error).not.toBeNull()
  })

  it('recusa status inicial fora de draft e scheduled', async () => {
    const { error } = await criarPeloBackend(
      userA.id,
      post({ status: 'published' }),
    )
    expect(error).not.toBeNull()
  })

  it('recusa status inicial inválido no comentário', async () => {
    const { error } = await criarPeloBackend(userA.id, post(), {
      body: 'Comentário',
      mode: 'immediate',
      status: 'published',
    })
    expect(error).not.toBeNull()
  })

  it('aceita rascunho', async () => {
    const { error } = await criarPeloBackend(userA.id, post({ status: 'draft' }))
    expect(error).toBeNull()
  })
})

describe('reschedule e cancel pelo backend', () => {
  it('reagenda uma publicação', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post())
    const novo = new Date(Date.now() + 86_400_000).toISOString()

    const { error } = await adminClient().rpc('reschedule_scheduled_post', {
      p_owner_id: userA.id,
      p_post_id: postId as string,
      p_scheduled_at: novo,
      p_timezone: 'America/Sao_Paulo',
    })
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('scheduled_at')
      .eq('id', postId as string)
      .single()
    expect(new Date(data!.scheduled_at).toISOString()).toBe(novo)
  })

  it('recusa reagendar publicação de outro owner', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post())

    const { error } = await adminClient().rpc('reschedule_scheduled_post', {
      p_owner_id: userB.id,
      p_post_id: postId as string,
      p_scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
      p_timezone: 'America/Sao_Paulo',
    })
    expect(error).not.toBeNull()
  })

  it('cancela a publicação e os comentários pendentes', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post(), {
      body: 'Comentário',
      mode: 'immediate',
    })

    const { error } = await adminClient().rpc('cancel_scheduled_post', {
      p_owner_id: userA.id,
      p_post_id: postId as string,
    })
    expect(error).toBeNull()

    const { data: p } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postId as string)
      .single()
    expect(p!.status).toBe('cancelled')

    const { data: c } = await adminClient()
      .from('scheduled_comments')
      .select('status')
      .eq('scheduled_post_id', postId as string)
    expect(c!.every((x) => x.status === 'cancelled')).toBe(true)
  })

  it('recusa cancelar publicação de outro owner', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post())

    const { error } = await adminClient().rpc('cancel_scheduled_post', {
      p_owner_id: userB.id,
      p_post_id: postId as string,
    })
    expect(error).not.toBeNull()
  })

  it.each(['processing', 'published', 'needs_review'])(
    'recusa reagendar publicação em %s',
    async (status) => {
      const { data: postId } = await criarPeloBackend(userA.id, post())
      await adminClient()
        .from('scheduled_posts')
        .update({ status })
        .eq('id', postId as string)

      const { error } = await adminClient().rpc('reschedule_scheduled_post', {
        p_owner_id: userA.id,
        p_post_id: postId as string,
        p_scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
        p_timezone: 'America/Sao_Paulo',
      })
      expect(error).not.toBeNull()
    },
  )
})

describe('mutação direta pelas tabelas continua fechada', () => {
  it('authenticated tem apenas SELECT nas tabelas de agendamento', async () => {
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

  it('UPDATE direto de scheduled_at é recusado', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post())
    const novo = new Date(Date.now() + 172_800_000).toISOString()

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
    expect(new Date(data!.scheduled_at).toISOString()).not.toBe(novo)
  })

  it('DELETE direto é recusado', async () => {
    const { data: postId } = await criarPeloBackend(userA.id, post())
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .delete()
      .eq('id', postId as string)
    expect(error).not.toBeNull()
  })
})
