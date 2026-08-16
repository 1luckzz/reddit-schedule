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
      reddit_user_id: `t2_sp_${sufixo}`,
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
      subreddit_fullname: `t5_sp_${sufixo}`,
      name: `com_${sufixo}`,
      display_name: `Comunidade ${sufixo}`,
      url: `/r/com_${sufixo}/`,
      submission_type: 'any',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

function postBase(overrides: Record<string, unknown> = {}) {
  return {
    owner_id: userA.id,
    reddit_account_id: contaA,
    subreddit_id: subA,
    title: 'Título de teste',
    url: 'https://exemplo.com/video',
    body: null,
    post_kind: 'link',
    scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
    timezone: 'America/Sao_Paulo',
    ...overrides,
  }
}

async function criarPost(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert(postBase(overrides))
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`sp-a-${stamp}@teste.local`)
  userB = await createTestUser(`sp-b-${stamp}@teste.local`)
  contaA = await criarConta(userA.id, `a${stamp}`)
  contaB = await criarConta(userB.id, `b${stamp}`)
  subA = await criarSub(userA.id, contaA, `a${stamp}`)
  subB = await criarSub(userB.id, contaB, `b${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('coerência do payload', () => {
  it('aceita link post com url e sem body', async () => {
    await expect(criarPost()).resolves.toBeTruthy()
  })

  it('aceita self post com body e sem url', async () => {
    await expect(
      criarPost({ post_kind: 'self', url: null, body: 'texto' }),
    ).resolves.toBeTruthy()
  })

  it('recusa link post sem url', async () => {
    await expect(criarPost({ url: null })).rejects.toBeTruthy()
  })

  it('recusa link post com body: a API do Reddit não aceita os dois', async () => {
    await expect(criarPost({ body: 'texto junto do link' })).rejects.toBeTruthy()
  })

  it('recusa self post com url', async () => {
    await expect(
      criarPost({ post_kind: 'self', url: 'https://exemplo.com', body: 't' }),
    ).rejects.toBeTruthy()
  })

  it('recusa post_kind fora da lista', async () => {
    await expect(criarPost({ post_kind: 'image' })).rejects.toBeTruthy()
  })

  it('recusa título vazio', async () => {
    await expect(criarPost({ title: '   ' })).rejects.toBeTruthy()
  })

  it('recusa título acima de 300 caracteres', async () => {
    await expect(criarPost({ title: 'x'.repeat(301) })).rejects.toBeTruthy()
  })
})

describe('integridade entre owners', () => {
  it('recusa post cuja conta é de outro owner', async () => {
    await expect(criarPost({ reddit_account_id: contaB })).rejects.toBeTruthy()
  })

  it('recusa post cuja comunidade é de outro owner', async () => {
    await expect(criarPost({ subreddit_id: subB })).rejects.toBeTruthy()
  })

  it('recusa comunidade que não pertence à conta escolhida', async () => {
    // Mesmo owner, mas a comunidade é de outra conta dele.
    const outraConta = await criarConta(userA.id, `outra${Date.now()}`)
    const subOutra = await criarSub(userA.id, outraConta, `outra${Date.now()}`)
    await expect(criarPost({ subreddit_id: subOutra })).rejects.toBeTruthy()
  })
})

describe('RLS de scheduled_posts', () => {
  it('o usuário lê apenas os próprios posts', async () => {
    await criarPost()
    const { data } = await userClient(userB.accessToken)
      .from('scheduled_posts')
      .select('id')
    expect(data).toHaveLength(0)
  })

  it('o usuário não insere direto, nem para si mesmo', async () => {
    // Criar publicação passa exclusivamente pela RPC, que aplica
    // post_requirements e as demais regras do domínio.
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .insert(postBase())
    expect(error).not.toBeNull()
  })

  it('o usuário não altera direto', async () => {
    const id = await criarPost()
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .update({ title: 'alterado por fora' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })

  it('o usuário não apaga posts: cancelar preserva o histórico', async () => {
    const id = await criarPost()
    const { error } = await userClient(userA.accessToken)
      .from('scheduled_posts')
      .delete()
      .eq('id', id)
    expect(error).not.toBeNull()
  })
})

describe('colunas gerenciadas pelo worker', () => {
  it('authenticated não tem UPDATE em coluna nenhuma', async () => {
    // Mutação passa exclusivamente pelas RPCs.
    const { rows } = await withSql((db) =>
      db.query(
        `select column_name from information_schema.column_privileges
         where grantee = 'authenticated' and table_name = 'scheduled_posts'
           and privilege_type = 'UPDATE'`,
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('o trigger recusa alteração das colunas de execução', async () => {
    const id = await criarPost()
    const colunas = ['reddit_post_id', 'locked_by', 'submit_attempted_at']
    for (const coluna of colunas) {
      await withSql((db) =>
        db.query(
          `grant update (${coluna}) on public.scheduled_posts to authenticated`,
        ),
      )
      try {
        const valor =
          coluna === 'submit_attempted_at' ? new Date().toISOString() : 'x'
        const { error } = await userClient(userA.accessToken)
          .from('scheduled_posts')
          .update({ [coluna]: valor })
          .eq('id', id)
        expect(error).not.toBeNull()
      } finally {
        await withSql((db) =>
          db.query(
            `revoke update (${coluna}) on public.scheduled_posts from authenticated`,
          ),
        )
      }
    }
  })
})

describe('máquina de estados', () => {
  async function transicionar(id: string, de: string, para: string) {
    await adminClient().from('scheduled_posts').update({ status: de }).eq('id', id)
    return adminClient().from('scheduled_posts').update({ status: para }).eq('id', id)
  }

  it('scheduled avança para processing', async () => {
    const id = await criarPost()
    expect((await transicionar(id, 'scheduled', 'processing')).error).toBeNull()
  })

  it('processing avança para published, failed e needs_review', async () => {
    for (const destino of ['published', 'failed', 'needs_review']) {
      const id = await criarPost()
      expect((await transicionar(id, 'processing', destino)).error).toBeNull()
    }
  })

  it('needs_review NUNCA volta para scheduled', async () => {
    // Regra central da spec: resultado ambíguo exige decisão humana, e
    // reagendar sozinho poderia duplicar a publicação.
    const id = await criarPost()
    expect(
      (await transicionar(id, 'needs_review', 'scheduled')).error,
    ).not.toBeNull()
  })

  it('needs_review pode ser resolvido manualmente', async () => {
    for (const destino of ['published', 'failed', 'cancelled']) {
      const id = await criarPost()
      expect((await transicionar(id, 'needs_review', destino)).error).toBeNull()
    }
  })

  it('published é terminal', async () => {
    for (const destino of ['scheduled', 'processing', 'failed', 'cancelled']) {
      const id = await criarPost()
      expect((await transicionar(id, 'published', destino)).error).not.toBeNull()
    }
  })

  it('cancelled é terminal', async () => {
    const id = await criarPost()
    expect((await transicionar(id, 'cancelled', 'scheduled')).error).not.toBeNull()
  })

  it('processing volta para scheduled apenas sem tentativa de envio', async () => {
    // É o caminho do reaper: worker morreu antes de enviar.
    const id = await criarPost()
    await adminClient()
      .from('scheduled_posts')
      .update({ status: 'processing', submit_attempted_at: null })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_posts')
      .update({ status: 'scheduled' })
      .eq('id', id)
    expect(error).toBeNull()
  })

  it('processing com envio tentado NÃO volta para scheduled', async () => {
    const id = await criarPost()
    await adminClient()
      .from('scheduled_posts')
      .update({
        status: 'processing',
        submit_attempted_at: new Date().toISOString(),
      })
      .eq('id', id)
    const { error } = await adminClient()
      .from('scheduled_posts')
      .update({ status: 'scheduled' })
      .eq('id', id)
    expect(error).not.toBeNull()
  })

  it('failed pode ser reagendado manualmente', async () => {
    const id = await criarPost()
    expect((await transicionar(id, 'failed', 'scheduled')).error).toBeNull()
  })
})
