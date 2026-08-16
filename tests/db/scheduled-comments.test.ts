import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let contaA: string
let contaOutra: string
let subA: string
let postA: string

async function criarConta(ownerId: string, sufixo: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_sc2_${sufixo}`,
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
      subreddit_fullname: `t5_sc2_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

function comentarioBase(overrides: Record<string, unknown> = {}) {
  return {
    owner_id: userA.id,
    scheduled_post_id: postA,
    reddit_account_id: contaA,
    body: 'Comentário automático',
    mode: 'immediate',
    ...overrides,
  }
}

async function criarComentario(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_comments')
    .insert(comentarioBase(overrides))
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`sc2-a-${stamp}@teste.local`)
  userB = await createTestUser(`sc2-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaOutra = await criarConta(userA.id, `o${stamp}`)
  subA = await criarSub(userA.id, contaA, `a${stamp}`)

  const { data } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: userA.id,
      reddit_account_id: contaA,
      subreddit_id: subA,
      title: 'Post com comentário',
      url: 'https://exemplo.com/x',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      timezone: 'America/Sao_Paulo',
    })
    .select('id')
    .single()
  postA = data!.id as string
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('coerência do modo', () => {
  it('aceita modo immediate sem delay nem horário', async () => {
    await expect(criarComentario()).resolves.toBeTruthy()
  })

  it('aceita modo delay com minutos', async () => {
    await expect(
      criarComentario({ mode: 'delay', delay_minutes: 10 }),
    ).resolves.toBeTruthy()
  })

  it('aceita modo absolute com horário', async () => {
    await expect(
      criarComentario({
        mode: 'absolute',
        scheduled_at: new Date(Date.now() + 7200_000).toISOString(),
      }),
    ).resolves.toBeTruthy()
  })

  it('recusa modo delay sem minutos', async () => {
    await expect(criarComentario({ mode: 'delay' })).rejects.toBeTruthy()
  })

  it('recusa modo absolute sem horário', async () => {
    await expect(criarComentario({ mode: 'absolute' })).rejects.toBeTruthy()
  })

  it('recusa modo immediate com minutos', async () => {
    await expect(
      criarComentario({ mode: 'immediate', delay_minutes: 5 }),
    ).rejects.toBeTruthy()
  })

  it('recusa delay negativo', async () => {
    await expect(
      criarComentario({ mode: 'delay', delay_minutes: -1 }),
    ).rejects.toBeTruthy()
  })

  it('recusa corpo vazio', async () => {
    await expect(criarComentario({ body: '   ' })).rejects.toBeTruthy()
  })
})

describe('comentário absoluto com horário já passado', () => {
  it('aceita horário no passado: o post pode publicar atrasado', async () => {
    // Se a fila atrasar, ou houver retentativa ou revisão manual, o horário
    // combinado pode já ter passado quando o post enfim publicar. O
    // comentário continua desejado — fica elegível logo após a publicação,
    // em vez de ser descartado.
    await expect(
      criarComentario({
        mode: 'absolute',
        scheduled_at: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    ).resolves.toBeTruthy()
  })

  it('não existe constraint exigindo horário futuro', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
         where conrelid = 'public.scheduled_comments'::regclass
           and contype = 'c'`,
      ),
    )
    const defs = rows.map((r) => String(r.def)).join(' ')
    expect(defs).not.toMatch(/scheduled_at\s*>\s*now\(\)/)
  })
})

describe('vínculo com o post', () => {
  it('recusa comentário de conta diferente da do post', async () => {
    // O comentário precisa sair pela mesma conta que publicou.
    await expect(
      criarComentario({ reddit_account_id: contaOutra }),
    ).rejects.toBeTruthy()
  })

  it('recusa comentário cujo owner diverge do post', async () => {
    await expect(criarComentario({ owner_id: userB.id })).rejects.toBeTruthy()
  })

  it('apagar o post apaga os comentários em cascata', async () => {
    const { data: post } = await adminClient()
      .from('scheduled_posts')
      .insert({
        owner_id: userA.id,
        reddit_account_id: contaA,
        subreddit_id: subA,
        title: 'Post temporário',
        post_kind: 'self',
        body: 'texto',
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'America/Sao_Paulo',
      })
      .select('id')
      .single()

    await criarComentario({ scheduled_post_id: post!.id })
    await adminClient().from('scheduled_posts').delete().eq('id', post!.id)

    const { data } = await adminClient()
      .from('scheduled_comments')
      .select('id')
      .eq('scheduled_post_id', post!.id)
    expect(data).toHaveLength(0)
  })
})

describe('RLS de scheduled_comments', () => {
  it('o usuário B não enxerga comentários de A', async () => {
    await criarComentario()
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_comments')
      .select('id')
    expect(data).toHaveLength(0)
  })

  it('o usuário A enxerga os próprios', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('scheduled_comments')
      .select('id')
    expect((data ?? []).length).toBeGreaterThan(0)
  })

  it('o usuário não insere direto', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_comments')
      .insert(comentarioBase())
    expect(error).not.toBeNull()
  })

  it('authenticated tem apenas SELECT', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_name = 'scheduled_comments'
         order by privilege_type`,
      ),
    )
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
  })
})

describe('máquina de estados do comentário', () => {
  it('needs_review não volta para scheduled', async () => {
    const id = await criarComentario()
    await adminClient()
      .from('scheduled_comments')
      .update({ status: 'needs_review' })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_comments')
      .update({ status: 'scheduled' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })

  it('published é terminal', async () => {
    const id = await criarComentario()
    await adminClient()
      .from('scheduled_comments')
      .update({ status: 'published' })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_comments')
      .update({ status: 'failed' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })

  it('processing com envio tentado não volta para a fila', async () => {
    const id = await criarComentario()
    await adminClient()
      .from('scheduled_comments')
      .update({
        status: 'processing',
        submit_attempted_at: new Date().toISOString(),
      })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_comments')
      .update({ status: 'scheduled' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })
})
