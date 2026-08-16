import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { withSql } from './sql'

let userA: { id: string; accessToken: string }
let conta: string

const COLUNAS_GERENCIADAS = [
  'status',
  'proxy_enabled',
  'proxy_protocol',
  'proxy_host_masked',
  'proxy_port',
  'scopes',
  'username',
  'reddit_user_id',
  'last_error',
]

/** Concede temporariamente UPDATE nas colunas gerenciadas a `authenticated`. */
async function comGrantAcidental<T>(fn: () => Promise<T>): Promise<T> {
  const colunas = COLUNAS_GERENCIADAS.join(', ')
  await withSql((db) =>
    db.query(
      `grant update (${colunas}) on public.reddit_accounts to authenticated`,
    ),
  )
  try {
    return await fn()
  } finally {
    await withSql((db) =>
      db.query(
        `revoke update (${colunas}) on public.reddit_accounts from authenticated`,
      ),
    )
  }
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`mct-${stamp}@teste.local`)

  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_mct_${stamp}`,
      username: 'conta_trigger',
      scopes: ['identity', 'submit'],
    })
    .select('id')
    .single()
  if (error) throw error
  conta = data.id as string

  await adminClient().from('reddit_account_network_configs').insert({
    reddit_account_id: conta,
    owner_id: userA.id,
    proxy_enabled: true,
    proxy_protocol: 'socks5',
    proxy_host: 'proxy.exemplo.com',
    proxy_port: 1080,
  })
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('protect_managed_account_columns é independente do grant', () => {
  it('a função é SECURITY INVOKER, para enxergar o papel real do chamador', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select prosecdef from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'protect_managed_account_columns'`,
      ),
    )
    expect(rows).toHaveLength(1)
    // SECURITY DEFINER faria current_user virar o dono da função sempre,
    // tornando impossível distinguir quem está atualizando.
    expect(rows[0].prosecdef).toBe(false)
  })

  it('o grant restritivo atual continua valendo (primeira barreira)', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select column_name from information_schema.column_privileges
         where grantee = 'authenticated' and table_name = 'reddit_accounts'
           and privilege_type = 'UPDATE' order by column_name`,
      ),
    )
    expect(rows.map((r) => r.column_name)).toEqual(['min_interval_seconds'])
  })

  it('com grant acidental sobre status, o trigger ainda recusa', async () => {
    // A transição precisa ser real: o trigger compara old e new, e um UPDATE
    // que grava o mesmo valor não altera nada que precise ser barrado.
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', conta)

    await comGrantAcidental(async () => {
      const { error } = await userClient(userA.accessToken)
        .from('reddit_accounts')
        .update({ status: 'connected' })
        .eq('id', conta)

      expect(error).not.toBeNull()
      // 42501 levantado pelo trigger — e não o de permissão negada, que nem
      // chegaria a executá-lo.
      expect(error!.message).toMatch(/mantidas pelo sistema/i)
    })

    // A conta continua desconectada: o usuário não conseguiu se reativar.
    const check = await adminClient()
      .from('reddit_accounts')
      .select('status')
      .eq('id', conta)
      .single()
    expect(check.data!.status).toBe('disconnected')

    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'connected' })
      .eq('id', conta)
  })

  it('um UPDATE que grava o mesmo valor não é barrado (não há alteração)', async () => {
    // Documenta a semântica: o trigger impede mudança, não escrita idêntica.
    await comGrantAcidental(async () => {
      const { error } = await userClient(userA.accessToken)
        .from('reddit_accounts')
        .update({ status: 'connected' })
        .eq('id', conta)
      expect(error).toBeNull()
    })
  })

  it('com grant acidental sobre proxy_enabled, o trigger ainda recusa', async () => {
    await comGrantAcidental(async () => {
      const { error } = await userClient(userA.accessToken)
        .from('reddit_accounts')
        .update({ proxy_enabled: false })
        .eq('id', conta)

      expect(error).not.toBeNull()
      expect(error!.message).toMatch(/mantidas pelo sistema/i)

      const check = await adminClient()
        .from('reddit_accounts')
        .select('proxy_enabled')
        .eq('id', conta)
        .single()
      expect(check.data!.proxy_enabled).toBe(true)
    })
  })

  it.each([
    ['proxy_host_masked', { proxy_host_masked: 'falso.exemplo.com' }],
    ['proxy_port', { proxy_port: 9999 }],
    ['scopes', { scopes: ['identity', 'modconfig'] }],
    ['username', { username: 'outro' }],
    ['reddit_user_id', { reddit_user_id: 't2_outro' }],
    ['last_error', { last_error: 'apagado' }],
  ])('com grant acidental sobre %s, o trigger ainda recusa', async (_col, patch) => {
    await comGrantAcidental(async () => {
      const { error } = await userClient(userA.accessToken)
        .from('reddit_accounts')
        .update(patch)
        .eq('id', conta)
      expect(error).not.toBeNull()
      expect(error!.message).toMatch(/mantidas pelo sistema/i)
    })
  })

  it('com grant acidental, min_interval_seconds continua editável', async () => {
    await comGrantAcidental(async () => {
      const { error } = await userClient(userA.accessToken)
        .from('reddit_accounts')
        .update({ min_interval_seconds: 450 })
        .eq('id', conta)
      expect(error).toBeNull()
    })

    const check = await adminClient()
      .from('reddit_accounts')
      .select('min_interval_seconds')
      .eq('id', conta)
      .single()
    expect(check.data!.min_interval_seconds).toBe(450)
  })

  it('mesmo com grant acidental, o mecanismo interno continua atualizando', async () => {
    await comGrantAcidental(async () => {
      await adminClient()
        .from('reddit_account_network_configs')
        .update({ proxy_host: 'interno.exemplo.com', proxy_port: 3128 })
        .eq('reddit_account_id', conta)

      const check = await adminClient()
        .from('reddit_accounts')
        .select('proxy_host_masked, proxy_port')
        .eq('id', conta)
        .single()
      expect(check.data!.proxy_host_masked).toBe('in***.exemplo.com')
      expect(check.data!.proxy_port).toBe(3128)
    })
  })

  it('o service_role continua podendo gerenciar as colunas', async () => {
    const { error } = await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected', last_error: 'REFRESH_INVALID' })
      .eq('id', conta)
    expect(error).toBeNull()

    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'connected', last_error: null })
      .eq('id', conta)
  })

  it('o grant temporário foi revertido ao fim de cada cenário', async () => {
    const { rows } = await withSql((db) =>
      db.query(
        `select column_name from information_schema.column_privileges
         where grantee = 'authenticated' and table_name = 'reddit_accounts'
           and privilege_type = 'UPDATE'`,
      ),
    )
    expect(rows.map((r) => r.column_name)).toEqual(['min_interval_seconds'])
  })
})
