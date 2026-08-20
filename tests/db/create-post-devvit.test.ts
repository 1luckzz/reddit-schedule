import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'

// ---------------------------------------------------------------
// O caminho do formulário, de ponta a ponta, contra o banco real:
// schema -> createPost -> RPC -> scheduled_posts. Só a identidade da sessão
// e o HTTP do Reddit são substituídos — a decisão automática de publisher, a
// RPC e os claims rodam de verdade.
// ---------------------------------------------------------------

const estado = vi.hoisted(() => ({
  ownerId: '',
  accessToken: '',
}))

vi.mock('@/lib/auth/require-user', () => ({
  requireUser: async () => ({ id: estado.ownerId }),
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}))

vi.mock('@/lib/auth/ownership', () => ({
  assertAccountAccess: async (id: string) => ({ id }),
  ForbiddenError: class ForbiddenError extends Error {},
}))

vi.mock('@/lib/supabase/server', async () => {
  const { userClient: clienteDoUsuario } = await import('./helpers')
  return {
    createServerSupabase: async () => clienteDoUsuario(estado.accessToken),
  }
})

vi.mock('@/lib/reddit/reddit-client-factory', () => ({
  getRedditClient: async () => ({}),
}))

vi.mock('@/lib/reddit/requirements', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/reddit/requirements')>()
  return {
    ...original,
    getPostRequirements: async () => original.FIELD_DEFAULTS,
  }
})

import { newPostSchema } from '@/app/(dashboard)/dashboard/new/schema'
import { createPost } from '@/lib/scheduling/create-post'
import { rotuloDevvit } from '@/lib/scheduling/status'

const SUB_NAME = 'famosinha_br'

let userA: { id: string; accessToken: string }
let conta: string
let sub: string
let instalacao: string

/** O mesmo objeto que o formulário envia, passado pelo mesmo schema. */
function inputDoFormulario(overrides: Record<string, string> = {}) {
  return newPostSchema.parse({
    accountId: conta,
    subredditId: sub,
    title: 'Validação do caminho Devvit',
    url: 'https://exemplo.com/validacao',
    body: '',
    flairId: '',
    date: '',
    time: '',
    timeZone: 'America/Sao_Paulo',
    // 'now' deixa o post vencido de imediato: é o que permite provar que o
    // worker NÃO o reivindica mesmo estando elegível por horário.
    publishMode: 'now',
    occurrence: '',
    commentBody: '',
    commentMode: 'immediate',
    commentDelayMinutes: '',
    commentDate: '',
    commentTime: '',
    ...overrides,
  })
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`cpd-${stamp}@teste.local`)
  estado.ownerId = userA.id
  estado.accessToken = userA.accessToken

  const { data: c } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_cpd_${stamp}`,
      username: 'conta_cpd',
      min_interval_seconds: 0,
    })
    .select('id')
    .single()
  conta = c!.id as string

  const { data: s } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: userA.id,
      reddit_account_id: conta,
      subreddit_fullname: `t5_cpd_${stamp}`,
      name: SUB_NAME,
      display_name: 'Famosinha BR',
      url: `/r/${SUB_NAME}/`,
    })
    .select('id')
    .single()
  sub = s!.id as string

  // Os identificadores reais da instalação de r/Famosinha_BR, capturados do
  // contexto oficial do Devvit (context.subredditId) em 2026-08-20.
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
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('formulário -> createPost com instalação Devvit ativa', () => {
  it('classifica automaticamente como devvit, com instalação e sync pending', async () => {
    const { postId } = await createPost(inputDoFormulario())

    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select(
        'publisher, devvit_installation_id, devvit_sync_status, devvit_job_id, devvit_sync_error, status',
      )
      .eq('id', postId)
      .single()

    expect(linha!.publisher).toBe('devvit')
    expect(linha!.devvit_installation_id).toBe(instalacao)
    expect(linha!.devvit_sync_status).toBe('pending')
    // A ponte está indisponível: nenhum job foi criado e nenhum erro foi
    // inventado — o registro apenas aguarda.
    expect(linha!.devvit_job_id).toBeNull()
    expect(linha!.devvit_sync_error).toBeNull()
    expect(linha!.status).toBe('scheduled')
  })

  it('a fila mostra "Aguardando sincronização" para esse registro', () => {
    // O rótulo é função pura dos campos que a página da fila seleciona.
    expect(rotuloDevvit('scheduled', 'devvit', 'pending')).toBe(
      'Aguardando sincronização',
    )
  })

  it('o worker NÃO reivindica o post devvit, mesmo vencido — sem fallback', async () => {
    const { postId } = await createPost(inputDoFormulario())

    // O mesmo claim que o worker roda em produção.
    const { data: pegos, error } = await adminClient().rpc('claim_due_posts', {
      p_worker_id: 'worker-validacao',
      p_batch: 50,
    })
    expect(error).toBeNull()
    expect((pegos ?? []).map((r: { id: string }) => r.id)).not.toContain(
      postId,
    )

    const { data: linha } = await adminClient()
      .from('scheduled_posts')
      .select('status, locked_by, locked_at, submit_attempted_at, publisher')
      .eq('id', postId)
      .single()
    expect(linha!.status).toBe('scheduled')
    expect(linha!.locked_by).toBeNull()
    expect(linha!.locked_at).toBeNull()
    // Nenhuma tentativa de envio: o caminho da Reddit Data API nunca começou.
    expect(linha!.submit_attempted_at).toBeNull()
    expect(linha!.publisher).toBe('devvit')
  })
})

describe('teste negativo: instalação desativada', () => {
  it('novo agendamento NÃO é classificado como devvit', async () => {
    await adminClient()
      .from('devvit_installations')
      .update({ status: 'disabled' })
      .eq('id', instalacao)

    try {
      const { postId } = await createPost(
        inputDoFormulario({ title: 'Com instalação desativada' }),
      )

      const { data: linha } = await adminClient()
        .from('scheduled_posts')
        .select('publisher, devvit_installation_id, devvit_sync_status')
        .eq('id', postId)
        .single()
      expect(linha!.publisher).toBe('worker')
      expect(linha!.devvit_installation_id).toBeNull()
      expect(linha!.devvit_sync_status).toBeNull()
    } finally {
      await adminClient()
        .from('devvit_installations')
        .update({ status: 'active' })
        .eq('id', instalacao)
    }
  })
})
