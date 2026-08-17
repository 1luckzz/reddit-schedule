import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { Agent } from 'undici'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { acquireQueueLock, releaseQueueLock } from './queue-lock'
import {
  criarJob,
  isolarOrcamento,
  lerJob,
  montarCenario,
  rodar,
  type Cenario,
} from '../worker/post-job-helpers'

// ---------------------------------------------------------------
// O cenário mais perigoso do sistema
// ---------------------------------------------------------------
// O Reddit recebe o POST, cria a publicação, e a conexão cai antes da
// resposta. O worker não tem como saber se publicou. NUNCA pode retentar.
//
// O teste com MockAgent (em post-runner.test.ts) cobre a classificação, mas
// não prova o caminho real: lá o erro é fabricado pelo mock, sem que byte
// nenhum tenha trafegado. Aqui sobe um servidor HTTP local de verdade, que lê
// o corpo inteiro e só então destrói o socket. É a diferença entre "o código
// trata um erro chamado ECONNRESET" e "o código trata um POST que chegou ao
// outro lado".
//
// Não se provoca isso contra a API real: seria publicar de verdade para testar.

let servidor: Server
let porta: number
let userA: { id: string; accessToken: string }
let cenario: Cenario

/** Prova que o upstream realmente recebeu o corpo antes de cair. */
let corpoRecebido = ''
let recebeuPost = false

beforeAll(async () => {
  // Este arquivo chama claim e reaper, que varrem a fila inteira: sem o lock
  // ele reivindicaria e devolveria jobs de outros arquivos de teste.
  await acquireQueueLock()
  await isolarOrcamento('dc')
  userA = await createTestUser(`dc-${Date.now()}@teste.local`)
  cenario = await montarCenario(userA.id, 'dc')

  servidor = createServer((req, res) => {
    if (req.method !== 'POST') {
      // Os GETs de requisitos respondem normalmente: só a submissão cai.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }

    const partes: Buffer[] = []
    req.on('data', (c) => partes.push(c as Buffer))
    req.on('end', () => {
      // Neste ponto o "Reddit" recebeu o pedido completo. Do lado de lá, a
      // publicação existiria. Só então a conexão morre.
      corpoRecebido = Buffer.concat(partes).toString('utf8')
      recebeuPost = true
      res.socket?.destroy()
    })
  })

  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', () => ok()))
  porta = (servidor.address() as AddressInfo).port
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
  await new Promise<void>((ok) => servidor.close(() => ok()))
  await releaseQueueLock()
})

/**
 * Dispatcher que redireciona oauth.reddit.com para o servidor local.
 *
 * O `connect` customizado é o que mantém o teste honesto: a URL, os headers e
 * o corpo continuam sendo exatamente os que iriam para o Reddit. Só o destino
 * TCP muda.
 */
function dispatcherLocal() {
  return new Agent({
    connect: (_opts, callback) => {
      const socket = netConnect(porta, '127.0.0.1')
      socket.on('connect', () => callback(null, socket))
      socket.on('error', (e) => callback(e, null))
    },
  })
}

describe('conexão derrubada depois do envio', () => {
  it('o upstream recebe o POST e o job termina em needs_review', async () => {
    recebeuPost = false
    const j = await criarJob(cenario)
    await rodar(j, { dispatcher: dispatcherLocal() })

    // 1. O pedido chegou de verdade ao outro lado.
    expect(recebeuPost).toBe(true)
    expect(corpoRecebido).toContain('kind=')
    expect(corpoRecebido).toContain('sr=com_dc')

    // 2. O desfecho é revisão manual, nunca falha nem republicação.
    const depois = await lerJob(j.id)
    expect(depois.status).toBe('needs_review')
    expect(depois.review_reason).toBeTruthy()
  })

  it('submit_attempted_at permanece gravado', async () => {
    // É o registro de que algo pode ter saído. Limpá-lo autorizaria uma
    // segunda publicação.
    const j = await criarJob(cenario)
    await rodar(j, { dispatcher: dispatcherLocal() })

    expect((await lerJob(j.id)).submit_attempted_at).not.toBeNull()
  })

  it('NÃO agenda nova tentativa', async () => {
    const j = await criarJob(cenario)
    await rodar(j, { dispatcher: dispatcherLocal() })

    const depois = await lerJob(j.id)
    expect(depois.next_attempt_at).toBeNull()
    expect(depois.retry_count).toBe(0)
  })

  it('o claim não pega o job de volta para republicar', async () => {
    const j = await criarJob(cenario)
    await rodar(j, { dispatcher: dispatcherLocal() })

    const { data } = await adminClient().rpc('claim_due_posts', {
      p_worker_id: 'worker-teste-dc',
      p_batch: 50,
    })
    expect(
      ((data ?? []) as { id: string }[]).map((r) => r.id),
    ).not.toContain(j.id)
  })

  it('o reaper também não o devolve à fila', async () => {
    const j = await criarJob(cenario)
    await rodar(j, { dispatcher: dispatcherLocal() })

    const { data } = await adminClient().rpc('reap_stale_jobs', {
      p_timeout_seconds: 0,
    })
    const devolvidos = ((data ?? []) as { job_id: string; outcome: string }[])
      .filter((r) => r.outcome === 'requeued')
      .map((r) => r.job_id)
    expect(devolvidos).not.toContain(j.id)
  })

  it('o erro classificado não autoriza repetir o efeito', async () => {
    // Amarra este cenário ao contrato de safeToRetryEffect.
    const j = await criarJob(cenario)
    const { erro } = await rodar(j, { dispatcher: dispatcherLocal() })

    expect(erro).toMatchObject({
      disposition: 'unknown',
      safeToRetryEffect: false,
    })
  })

  it('o log registra outcome unknown, não failure', async () => {
    const j = await criarJob(cenario)
    await rodar(j, { dispatcher: dispatcherLocal() })

    const { data } = await adminClient()
      .from('execution_logs')
      .select('outcome')
      .eq('scheduled_post_id', j.id)
    const desfechos = (data ?? []).map((l) => l.outcome)
    expect(desfechos).toContain('unknown')
    expect(desfechos).not.toContain('failure')
  })
})
