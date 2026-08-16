// tests/db/scheduling-isolation.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaB: string
let subA: string
let subB: string
let postA: string
let comentarioA: string

async function montar(ownerId: string, sufixo: string) {
  const { data: conta } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_si_${sufixo}`,
      username: `conta_${sufixo}`,
    })
    .select('id')
    .single()

  const { data: sub } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: conta!.id,
      subreddit_fullname: `t5_si_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
    })
    .select('id')
    .single()

  return { conta: conta!.id as string, sub: sub!.id as string }
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`si-a-${stamp}@teste.local`)
  userB = await createTestUser(`si-b-${stamp}@teste.local`)

  const a = await montar(userA.id, `a${stamp}`)
  const b = await montar(userB.id, `b${stamp}`)
  contaA = a.conta
  subA = a.sub
  contaB = b.conta
  subB = b.sub

  const { data: post } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: contaA,
      subreddit_id: subA,
      title: 'Post de A',
      url: 'https://exemplo.com/a',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
    })
    .select('id')
    .single()
  postA = post!.id as string

  const { data: comentario } = await adminClient()
    .from('scheduled_comments')
    .insert({
      owner_id: userA.id,
      scheduled_post_id: postA,
      reddit_account_id: contaA,
      body: 'Comentário de A',
      mode: 'immediate',
    })
    .select('id')
    .single()
  comentarioA = comentario!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('isolamento de publicações', () => {
  it('B não lê publicações de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .select('id')
      .eq('id', postA)
    expect(data).toHaveLength(0)
  })

  it('B não lê comentários de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .select('id')
      .eq('id', comentarioA)
    expect(data).toHaveLength(0)
  })

  it('B não altera publicação de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .update({ title: 'invadido' })
      .eq('id', postA)
      .select()
    expect(data ?? []).toHaveLength(0)

    const check = await adminClient()
      .from('scheduled_posts')
      .select('title')
      .eq('id', postA)
      .single()
    expect(check.data!.title).toBe('Post de A')
  })

  it('B não cancela publicação de A', async () => {
    await userClient(userB.accessToken)
      .from('scheduled_posts')
      .update({ status: 'cancelled' })
      .eq('id', postA)

    const check = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postA)
      .single()
    expect(check.data!.status).not.toBe('cancelled')
  })

  it('B não cria publicação com a conta de A', async () => {
    const { error } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .insert({
        owner_id: userB.id,
        reddit_account_id: contaA,
        subreddit_id: subA,
        title: 'Tentativa',
        url: 'https://exemplo.com/x',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
      })
    expect(error).not.toBeNull()
  })

  it('B não cria comentário no post de A', async () => {
    const { error } = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .insert({
        owner_id: userB.id,
        scheduled_post_id: postA,
        reddit_account_id: contaB,
        body: 'Comentário intruso',
        mode: 'immediate',
      })
    expect(error).not.toBeNull()
  })

  it('B não usa a comunidade de A com a própria conta', async () => {
    const { error } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .insert({
        owner_id: userB.id,
        reddit_account_id: contaB,
        subreddit_id: subA,
        title: 'Tentativa',
        url: 'https://exemplo.com/x',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
      })
    expect(error).not.toBeNull()
  })

  it('a listagem de B não contém nada de A', async () => {
    const posts = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .select('owner_id')
    expect((posts.data ?? []).every((p) => p.owner_id === userB.id)).toBe(true)

    const comentarios = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .select('owner_id')
    expect((comentarios.data ?? []).every((c) => c.owner_id === userB.id)).toBe(
      true,
    )
  })
})

describe('isolamento pelo caminho das RPCs', () => {
  // As RPCs de mutação são exclusivas do service_role: o cliente não as
  // executa de forma alguma. Estes testes confirmam as duas metades — o
  // cliente é barrado, e o backend respeita o owner que recebe.

  it('o usuário autenticado não executa a RPC de criação', async () => {
    const { error } = await userClient(userB.accessToken).rpc(
      'create_scheduled_post',
      {
        p_owner_id: userB.id,
        p_post: {
          reddit_account_id: contaB,
          subreddit_id: subB,
          title: 'Tentativa via RPC',
          url: 'https://exemplo.com/x',
          post_kind: 'link',
          scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
          timezone: 'America/Sao_Paulo',
          status: 'scheduled',
        },
        p_comment: null,
      },
    )
    // Sem EXECUTE, o PostgREST nem expõe a função ao cliente.
    expect(error).not.toBeNull()
  })

  it('o usuário autenticado não executa a RPC de cancelamento', async () => {
    const { error } = await userClient(userB.accessToken).rpc(
      'cancel_scheduled_post',
      { p_owner_id: userB.id, p_post_id: postA },
    )
    expect(error).not.toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postA)
      .single()
    expect(data!.status).not.toBe('cancelled')
  })

  it('o backend recusa criar com conta que não é do owner informado', async () => {
    const { error } = await adminClient().rpc('create_scheduled_post', {
      p_owner_id: userB.id,
      p_post: {
        reddit_account_id: contaA,
        subreddit_id: subA,
        title: 'Conta alheia',
        url: 'https://exemplo.com/x',
        post_kind: 'link',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
        status: 'scheduled',
      },
      p_comment: null,
    })
    expect(error).not.toBeNull()
  })

  it('o backend recusa cancelar publicação de outro owner', async () => {
    const { error } = await adminClient().rpc('cancel_scheduled_post', {
      p_owner_id: userB.id,
      p_post_id: postA,
    })
    expect(error).not.toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('status')
      .eq('id', postA)
      .single()
    expect(data!.status).not.toBe('cancelled')
  })

  it('o owner gravado é o parâmetro verificado, não o do payload', async () => {
    const { data: postId, error } = await adminClient().rpc(
      'create_scheduled_post',
      {
        p_owner_id: userA.id,
        p_post: {
          // Ignorado: a função usa p_owner_id.
          owner_id: userB.id,
          reddit_account_id: contaA,
          subreddit_id: subA,
          title: 'Owner vem do parâmetro',
          url: 'https://exemplo.com/x',
          post_kind: 'link',
          scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
          timezone: 'America/Sao_Paulo',
          status: 'scheduled',
        },
        p_comment: null,
      },
    )
    expect(error).toBeNull()

    const { data } = await adminClient()
      .from('scheduled_posts')
      .select('owner_id')
      .eq('id', postId as string)
      .single()
    expect(data!.owner_id).toBe(userA.id)
  })
})
