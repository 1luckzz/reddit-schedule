import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import { logExecution } from '@/lib/worker/log'

let userA: { id: string; accessToken: string }

beforeAll(async () => {
  userA = await createTestUser(`lw-${Date.now()}@teste.local`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

async function ultimoLog() {
  const { data } = await adminClient()
    .from('execution_logs')
    .select('*')
    .eq('owner_id', userA.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  return data!
}

describe('logExecution', () => {
  it('grava a entrada', async () => {
    await logExecution(adminClient(), {
      ownerId: userA.id,
      action: 'submit_post',
      outcome: 'success',
      httpStatus: 200,
      durationMs: 420,
    })

    const log = await ultimoLog()
    expect(log.action).toBe('submit_post')
    expect(log.outcome).toBe('success')
    expect(log.http_status).toBe(200)
  })

  it('SANITIZA a mensagem antes de gravar', async () => {
    await logExecution(adminClient(), {
      ownerId: userA.id,
      action: 'submit_post',
      outcome: 'failure',
      errorMessage:
        'falhou com Authorization: bearer eyJabc123 via socks5://user:senha@proxy.exemplo.com:1080',
    })

    const log = await ultimoLog()
    expect(log.error_message).not.toContain('eyJabc123')
    expect(log.error_message).not.toContain('senha')
    expect(log.error_message).not.toContain('user:senha')
  })

  it('falha ao gravar log não derruba a operação', async () => {
    // Log é telemetria: um problema aqui não pode custar a publicação.
    await expect(
      logExecution(adminClient(), {
        ownerId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        action: 'submit_post',
        outcome: 'success',
      }),
    ).resolves.toBeUndefined()
  })

  it('trunca mensagem muito longa', async () => {
    await logExecution(adminClient(), {
      ownerId: userA.id,
      action: 'submit_post',
      outcome: 'failure',
      errorMessage: 'x'.repeat(5000),
    })

    const log = await ultimoLog()
    expect(log.error_message!.length).toBeLessThanOrEqual(2000)
  })
})
