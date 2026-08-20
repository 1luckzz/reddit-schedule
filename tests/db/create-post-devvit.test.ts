import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'

// ---------------------------------------------------------------
// O caminho Devvit de ponta a ponta, contra o banco real, SEM NENHUMA
// credencial REDDIT_* no ambiente e SEM conta Reddit ou subreddit no banco.
// Só a identidade da sessão e o cookie-store do Next são substituídos — a
// decisão de destino, a RPC, as constraints e os claims rodam de verdade.
// ---------------------------------------------------------------

const estado = vi.hoisted(() => ({
  ownerId: '',
  accessToken: '',
}))

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: async () => ({ id: estado.ownerId }),
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}))

vi.mock('@/lib/supabase/server', async () => {
  const { userClient } = await import('./helpers')
  return {
    createServerSupabase: async () => userClient(estado.accessToken),
  }
})

import { newDevvitPostSchema, newPostSchema } from '@/app/(dashboard)/dashboard/new/schema'
import {
  createDevvitPost,
  DevvitInstallationError,
} from '@/lib/scheduling/create-devvit-post'
import { rotuloDevvit } from '@/lib/scheduling/status'

const SUB_NAME = 'famosinha_br'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let instalacao: string
let instalacaoDeB: string

/** O mesmo objeto que o formulário Devvit envia, pelo mesmo schema. */
function inputDoFormulario(overrides: Record<string, string> = {}) {
  return newDevvitPostSchema.parse({
    devvitInstallationId: instalacao,
    title: 'Validação do caminho Devvit sem Data API',
    url: 'https://exemplo.com/validacao',
    body: 'texto que vira primeiro comentário',
    allowCommentFallback: 'on',
    date: '',
    time: '',
    timeZone: 'America/Sao_Paulo',
    // 'now' deixa o post vencido de imediato: é o que permite provar que o
    // worker NÃO o reivindica mesmo estando elegível por horário.
    publishMode: 'now',
    occurrence: '',
    commentBody: '',
    ...overrides,
  })
}

beforeAll(async () => {
  // A prova central: NENHUMA credencial do Reddit existe no ambiente. Se
  // qualquer trecho do caminho Devvit carregar o redditSchema, o teste quebra
  // com o erro de env — e é exatamente o que queremos detectar.
  delete process.env.REDDIT_CLIENT_ID
  delete process.env.REDDIT_CLIENT_SECRET
  delete process.env.REDDIT_REDIRECT_URI
  delete process.env.REDDIT_USER_AGENT

  const stamp = Date.now()
  userA = await createTestUser(`cdp-${stamp}@teste.local`)
  userB = await createTestUser(`cdp-b-${stamp}@teste.local`)
  estado.ownerId = userA.id
  estado.accessToken = userA.accessToken

  // Identificadores reais da instalação de r/Famosinha_BR (context.subredditId).
  // De propósito, NÃO criamos reddit_accounts nem subreddits: o caminho Devvit
  // não pode depender deles.
  const { data: i, error } = await adminClient()
    .from('devvit_installations')
    .insert({
      owner_id: userA.id,
      subreddit_name: SUB_NAME,
      app_slug: 'grapepos2',
      install_location_id: 't5_ji4dpk',
    })
    .select('id')
    .single()
  if (error) throw error
  instalacao = i!.id as string

  const { data: ib } = await adminClient()
    .from('devvit_installations')
    .insert({
      owner_id: userB.id,
      subreddit_name: SUB_NAME,
      app_slug: 'grapepos2',
    })
    .select('id')
    .single()
  instalacaoDeB = ib!.id as string
})

afterAll(async () => {
  // A FK protege instalações com histórico; o cascade do usuário remove tudo.
  await cleanupTestUsers([userA.id, userB.id])
})

describe('fluxo Devvit sem REDDIT_* e sem conta Reddit', () => {
  it('as credenciais Reddit realmente não existem no ambiente', () => {
    expect(process.env.REDDIT_CLIENT_ID).toBeUndefined()
    expect(process.env.REDDIT_CLIENT_SECRET).toBeUndefined()
    expect(process.env.REDDIT_REDIRECT_URI).toBeUndefined()
    expect(process.env.REDDIT_USER_AGENT).toBeUndefined()
  })

  it('cria o agendamento completo: post sem conta/comunidade + comentário sem conta', async () => {
    const { postId } = await createDevvitPost(inputDoFormulario())

    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select(
        `publisher, devvit_installation_id, devvit_sync_status, devvit_job_id,
         devvit_sync_error, status, reddit_account_id, subreddit_id,
         post_kind, url, body`,
      )
      .eq('id', postId)
      .single()

    expect(linha!.publisher).toBe('devvit')
    expect(linha!.devvit_installation_id).toBe(instalacao)
    expect(linha!.devvit_sync_status).toBe('pending')
    expect(linha!.devvit_job_id).toBeNull()
    expect(linha!.devvit_sync_error).toBeNull()
    expect(linha!.status).toBe('scheduled')
    expect(linha!.reddit_account_id).toBeNull()
    expect(linha!.subreddit_id).toBeNull()
    // link + texto confirmado → o texto vira comentário, não body.
    expect(linha!.post_kind).toBe('link')
    expect(linha!.body).toBeNull()

    const { data: comentario } = await adminClient()
      .from('scheduled_comments')
      .select('reddit_account_id, mode, body, status')
      .eq('scheduled_post_id', postId)
      .single()
    expect(comentario!.reddit_account_id).toBeNull()
    expect(comentario!.mode).toBe('immediate')
    expect(comentario!.body).toBe('texto que vira primeiro comentário')
  })

  it('a fila mostra "Aguardando sincronização" para esse registro', () => {
    expect(rotuloDevvit('scheduled', 'devvit', 'pending')).toBe(
      'Aguardando sincronização',
    )
  })

  it('o worker NÃO reivindica o post devvit vencido, nem seu comentário', async () => {
    const { postId } = await createDevvitPost(inputDoFormulario())

    const { data: pegos } = await adminClient().rpc('claim_due_posts', {
      p_worker_id: 'worker-validacao',
      p_batch: 50,
    })
    expect((pegos ?? []).map((r: { id: string }) => r.id)).not.toContain(
      postId,
    )

    const { data: comentarios } = await adminClient().rpc(
      'claim_due_comments',
      { p_worker_id: 'worker-validacao', p_batch: 50 },
    )
    const idsComentarios = ((comentarios ?? []) as { scheduled_post_id: string }[])
      .map((c) => c.scheduled_post_id)
    expect(idsComentarios).not.toContain(postId)

    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select('status, locked_by, locked_at, submit_attempted_at')
      .eq('id', postId)
      .single()
    expect(linha!.status).toBe('scheduled')
    expect(linha!.locked_by).toBeNull()
    expect(linha!.locked_at).toBeNull()
    expect(linha!.submit_attempted_at).toBeNull()
  })

  it('rejeita instalação desativada', async () => {
    await adminClient()
      .from('devvit_installations')
      .update({ status: 'disabled' })
      .eq('id', instalacao)
    try {
      await expect(createDevvitPost(inputDoFormulario())).rejects.toThrow(
        DevvitInstallationError,
      )
    } finally {
      await adminClient()
        .from('devvit_installations')
        .update({ status: 'active' })
        .eq('id', instalacao)
    }
  })

  it('rejeita instalação de outro owner (a RLS nem a enxerga)', async () => {
    await expect(
      createDevvitPost(
        inputDoFormulario({ devvitInstallationId: instalacaoDeB }),
      ),
    ).rejects.toThrow(DevvitInstallationError)
  })

  it('rejeita id de instalação inexistente', async () => {
    await expect(
      createDevvitPost(
        inputDoFormulario({
          devvitInstallationId: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow(DevvitInstallationError)
  })
})

describe('o navegador não escolhe publisher nem owner', () => {
  it('o schema Devvit descarta publisher, owner e subreddit enviados', () => {
    const parsed = newDevvitPostSchema.parse({
      devvitInstallationId: instalacao,
      publisher: 'worker',
      owner_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      subredditName: 'outra_comunidade',
      title: 'Título',
      url: 'https://exemplo.com/x',
      body: '',
      date: '',
      time: '',
      timeZone: 'America/Sao_Paulo',
      publishMode: 'now',
      occurrence: '',
      commentBody: '',
    })
    expect(Object.keys(parsed)).not.toContain('publisher')
    expect(Object.keys(parsed)).not.toContain('owner_id')
    expect(Object.keys(parsed)).not.toContain('subredditName')
  })

  it('o schema legacy também não aceita publisher', () => {
    const parsed = newPostSchema.parse({
      publisher: 'devvit',
      accountId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
      subredditId: '3f2504e0-4f89-11d3-9a0c-0305e82c3303',
      title: 'Título',
      url: 'https://exemplo.com/x',
      body: '',
      flairId: '',
      date: '',
      time: '',
      timeZone: 'America/Sao_Paulo',
      publishMode: 'now',
      occurrence: '',
      commentBody: '',
      commentMode: 'immediate',
      commentDelayMinutes: '',
      commentDate: '',
      commentTime: '',
    })
    expect(Object.keys(parsed)).not.toContain('publisher')
  })
})
