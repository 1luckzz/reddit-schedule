import { createHash } from 'node:crypto'
import type { Dispatcher } from 'undici'
import { adminClient } from '../db/helpers'
import { runPost, type PostJob, type RunResult } from '../../worker/post-runner'
import { encryptSecret } from '@/lib/crypto/aes-gcm'

/**
 * Dá a este arquivo de teste um `client_id` só seu e deixa o orçamento com
 * saldo folgado.
 *
 * O orçamento é global por `client_id`, então sem isto os arquivos de teste
 * disputariam a mesma linha e o bootstrap — que permite apenas uma requisição
 * em voo enquanto o saldo é desconhecido — recusaria chamadas legítimas.
 */
export async function isolarOrcamento(prefixo: string): Promise<void> {
  process.env.REDDIT_CLIENT_ID = `cid-${prefixo}-${Date.now()}`
  process.env.REDDIT_CLIENT_SECRET = 'csecret-fake'
  process.env.REDDIT_REDIRECT_URI = 'http://localhost:3000/api/reddit/callback'
  process.env.REDDIT_USER_AGENT = 'web:reddit-scheduler:test (by /u/teste)'

  const hash = createHash('sha256')
    .update(process.env.REDDIT_CLIENT_ID)
    .digest('hex')

  await adminClient().from('reddit_api_budget').insert({
    client_id_hash: hash,
    used: 1,
    remaining: 500,
    reset_at: new Date(Date.now() + 600_000).toISOString(),
    reserved: 0,
  })
}

/**
 * Arranjo compartilhado entre os testes do runner e os da conexão derrubada.
 *
 * Fica em arquivo próprio porque duplicá-lo faria os dois divergirem com o
 * tempo — e é justamente a coerência entre eles que interessa.
 */
export type Cenario = {
  ownerId: string
  contaId: string
  subredditId: string
  subredditName: string
}

export async function montarCenario(
  ownerId: string,
  prefixo: string,
): Promise<Cenario> {
  const stamp = `${prefixo}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const { data: conta, error: erroConta } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_${stamp}`,
      username: `conta_${prefixo}`,
      status: 'connected',
      min_interval_seconds: 0,
      scopes: ['identity', 'submit', 'read', 'flair'],
    })
    .select('id')
    .single()
  if (erroConta) throw erroConta
  const contaId = conta!.id as string

  // Token válido por uma hora: o runner não deve tentar renovar.
  const { error: erroSegredo } = await adminClient()
    .from('reddit_account_secrets')
    .insert({
      reddit_account_id: contaId,
      owner_id: ownerId,
      access_token_enc: encryptSecret(
        'access-token-de-teste',
        `reddit_account_secrets:access_token:${contaId}`,
      ),
      refresh_token_enc: encryptSecret(
        'refresh-token-de-teste',
        `reddit_account_secrets:refresh_token:${contaId}`,
      ),
      access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
  if (erroSegredo) throw erroSegredo

  const subredditName = `com_${prefixo}`
  const { data: sub, error: erroSub } = await adminClient()
    .from('subreddits')
    .insert({
      owner_id: ownerId,
      reddit_account_id: contaId,
      subreddit_fullname: `t5_${stamp}`,
      name: subredditName,
      display_name: 'Comunidade de teste',
      url: `/r/${subredditName}/`,
      submission_type: 'any',
      link_flair_enabled: true,
      status: 'active',
    })
    .select('id')
    .single()
  if (erroSub) throw erroSub

  return {
    ownerId,
    contaId,
    subredditId: sub!.id as string,
    subredditName,
  }
}

export async function criarJob(
  cenario: Cenario,
  overrides: Record<string, unknown> = {},
): Promise<PostJob> {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .insert({
      owner_id: cenario.ownerId,
      reddit_account_id: cenario.contaId,
      subreddit_id: cenario.subredditId,
      title: 'Título do job',
      url: 'https://exemplo.com/v',
      post_kind: 'link',
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
      timezone: 'America/Sao_Paulo',
      // Já reivindicado: o runner recebe o job depois do claim.
      status: 'processing',
      locked_by: 'worker-teste',
      locked_at: new Date().toISOString(),
      ...overrides,
    })
    .select(
      'id, owner_id, reddit_account_id, subreddit_id, title, url, body, post_kind, flair_id, nsfw, spoiler, retry_count',
    )
    .single()
  if (error) throw error
  return data as unknown as PostJob
}

export async function lerJob(id: string) {
  const { data, error } = await adminClient()
    .from('scheduled_posts')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data!
}

export function rodar(
  job: PostJob,
  opts: { dispatcher?: Dispatcher } = {},
): Promise<RunResult> {
  return runPost(job, opts)
}
