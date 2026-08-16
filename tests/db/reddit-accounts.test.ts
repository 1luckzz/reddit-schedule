import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupTestUsers, createTestUser, userClient } from './helpers'
import { maskHost } from '@/lib/logging/sanitize'

let userA: { id: string; accessToken: string }
let userB: { id: string; accessToken: string }
let accountA: string
let accountB: string

async function createAccount(ownerId: string, username: string) {
  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: ownerId,
      reddit_user_id: `t2_${username}`,
      username,
      scopes: ['identity', 'submit'],
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

beforeAll(async () => {
  const stamp = Date.now()
  userA = await createTestUser(`ra-a-${stamp}@teste.local`)
  userB = await createTestUser(`ra-b-${stamp}@teste.local`)
  accountA = await createAccount(userA.id, `conta_a_${stamp}`)
  accountB = await createAccount(userB.id, `conta_b_${stamp}`)
})

afterAll(async () => {
  await cleanupTestUsers([userA.id, userB.id])
})

describe('reddit_accounts', () => {
  it('o usuário lê apenas as próprias contas', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .select('id')
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(accountA)
  })

  it('o usuário A não enxerga a conta de B nem pedindo pelo id', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .select('id')
      .eq('id', accountB)
    expect(data).toHaveLength(0)
  })

  it('o usuário A não altera a conta de B', async () => {
    // min_interval_seconds é a única coluna que o dono pode atualizar, então
    // é ela que isola a RLS do grant: aqui o que barra é a posse, não a
    // permissão de coluna.
    const { data } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .update({ min_interval_seconds: 999 })
      .eq('id', accountB)
      .select()
    expect(data ?? []).toHaveLength(0)

    const check = await adminClient()
      .from('reddit_accounts')
      .select('min_interval_seconds')
      .eq('id', accountB)
      .single()
    expect(check.data!.min_interval_seconds).toBe(300)
  })

  it('o usuário autenticado não consegue inserir contas', async () => {
    // Contas nascem exclusivamente pelo fluxo OAuth, via service_role.
    const { error } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .insert({
        owner_id: userA.id,
        reddit_user_id: 't2_forjado',
        username: 'forjado',
      })
    expect(error).not.toBeNull()
  })

  it('impede duas contas com o mesmo reddit_user_id para o mesmo owner', async () => {
    const redditUserId = `t2_dup_${Date.now()}`
    const primeira = await adminClient().from('reddit_accounts').insert({
      owner_id: userA.id,
      reddit_user_id: redditUserId,
      username: 'dup',
    })
    expect(primeira.error).toBeNull()

    const segunda = await adminClient().from('reddit_accounts').insert({
      owner_id: userA.id,
      reddit_user_id: redditUserId,
      username: 'dup2',
    })
    expect(segunda.error).not.toBeNull()
  })

  it('impede a mesma identidade Reddit em owners diferentes', async () => {
    // Unicidade global: compartilhar a identidade quebraria o espaçamento por
    // conta, o lock de refresh e a configuração de rede única.
    const redditUserId = `t2_global_${Date.now()}`
    const a = await adminClient().from('reddit_accounts').insert({
      owner_id: userA.id,
      reddit_user_id: redditUserId,
      username: 'mesma_conta',
    })
    expect(a.error).toBeNull()

    const b = await adminClient().from('reddit_accounts').insert({
      owner_id: userB.id,
      reddit_user_id: redditUserId,
      username: 'mesma_conta',
    })
    expect(b.error).not.toBeNull()
  })

  it('rejeita status fora da lista permitida', async () => {
    const { error } = await adminClient()
      .from('reddit_accounts')
      .update({ status: 'inventado' })
      .eq('id', accountA)
    expect(error).not.toBeNull()
  })
})

describe('colunas gerenciadas pelo sistema', () => {
  // Conta própria: este bloco altera status e configuração de rede, e não
  // pode contaminar o estado que os outros describes verificam.
  let conta: string

  beforeAll(async () => {
    conta = await createAccount(userA.id, `gerenciada_${Date.now()}`)
    await adminClient().from('reddit_account_network_configs').insert({
      reddit_account_id: conta,
      owner_id: userA.id,
      proxy_enabled: true,
      proxy_protocol: 'socks5',
      proxy_host: 'proxy.exemplo.com',
      proxy_port: 1080,
    })
  })

  it('o dono não desabilita proxy_enabled direto na tabela', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .update({ proxy_enabled: false })
      .eq('id', conta)
    expect(error).not.toBeNull()

    const check = await adminClient()
      .from('reddit_accounts')
      .select('proxy_enabled')
      .eq('id', conta)
      .single()
    expect(check.data!.proxy_enabled).toBe(true)
  })

  it('o dono não altera proxy_host_masked, protocolo ou porta', async () => {
    for (const patch of [
      { proxy_host_masked: 'falso.exemplo.com' },
      { proxy_protocol: 'http' },
      { proxy_port: 9999 },
    ]) {
      const { error } = await userClient(userA.accessToken)
        .from('reddit_accounts')
        .update(patch)
        .eq('id', conta)
      expect(error).not.toBeNull()
    }

    const check = await adminClient()
      .from('reddit_accounts')
      .select('proxy_host_masked, proxy_protocol, proxy_port')
      .eq('id', conta)
      .single()
    expect(check.data!.proxy_host_masked).toBe('pr***.exemplo.com')
    expect(check.data!.proxy_protocol).toBe('socks5')
    expect(check.data!.proxy_port).toBe(1080)
  })

  it('o dono não reativa uma conta desconectada mexendo em status', async () => {
    await adminClient()
      .from('reddit_accounts')
      .update({ status: 'disconnected' })
      .eq('id', conta)

    const { error } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .update({ status: 'connected' })
      .eq('id', conta)
    expect(error).not.toBeNull()

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

  it('o dono não amplia os próprios scopes nem troca a identidade', async () => {
    for (const patch of [
      { scopes: ['identity', 'submit', 'modconfig'] },
      { reddit_user_id: 't2_outro' },
      { username: 'outro_nome' },
    ]) {
      const { error } = await userClient(userA.accessToken)
        .from('reddit_accounts')
        .update(patch)
        .eq('id', conta)
      expect(error).not.toBeNull()
    }
  })

  it('o dono não transfere a conta para outro owner', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .update({ owner_id: userB.id })
      .eq('id', conta)
    expect(error).not.toBeNull()
  })

  it('o dono ainda ajusta o que é dele: min_interval_seconds', async () => {
    const { error } = await userClient(userA.accessToken)
      .from('reddit_accounts')
      .update({ min_interval_seconds: 600 })
      .eq('id', conta)
    expect(error).toBeNull()

    const check = await adminClient()
      .from('reddit_accounts')
      .select('min_interval_seconds')
      .eq('id', conta)
      .single()
    expect(check.data!.min_interval_seconds).toBe(600)
  })

  it('o trigger interno continua atualizando os campos derivados', async () => {
    await adminClient()
      .from('reddit_account_network_configs')
      .update({ proxy_host: 'outro.exemplo.com', proxy_port: 3128 })
      .eq('reddit_account_id', conta)

    const check = await adminClient()
      .from('reddit_accounts')
      .select('proxy_host_masked, proxy_port')
      .eq('id', conta)
      .single()
    expect(check.data!.proxy_host_masked).toBe('ou***.exemplo.com')
    expect(check.data!.proxy_port).toBe(3128)
  })
})

describe('reddit_account_secrets', () => {
  beforeAll(async () => {
    const { error } = await adminClient().from('reddit_account_secrets').insert({
      reddit_account_id: accountA,
      owner_id: userA.id,
      access_token_enc: 'v1.aaa.bbb.ccc',
      refresh_token_enc: 'v1.ddd.eee.fff',
      access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    if (error) throw error
  })

  it('o dono da conta NÃO consegue ler os próprios segredos pelo Data API', async () => {
    const { data, error } = await userClient(userA.accessToken)
      .from('reddit_account_secrets')
      .select('access_token_enc')
    expect(data ?? []).toHaveLength(0)
    expect(JSON.stringify({ data, error })).not.toContain('v1.aaa')
  })

  it('o usuário B também não consegue', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('reddit_account_secrets')
      .select('access_token_enc')
    expect(data ?? []).toHaveLength(0)
  })

  it('rejeita segredo cujo owner_id diverge do owner da conta', async () => {
    const { error } = await adminClient().from('reddit_account_secrets').insert({
      reddit_account_id: accountB,
      owner_id: userA.id,
      access_token_enc: 'v1.x.y.z',
      refresh_token_enc: 'v1.x.y.z',
      access_token_expires_at: new Date().toISOString(),
    })
    expect(error).not.toBeNull()
  })

  it('apagar a conta apaga os segredos em cascata', async () => {
    const temp = await createAccount(userA.id, `tmp_${Date.now()}`)
    await adminClient().from('reddit_account_secrets').insert({
      reddit_account_id: temp,
      owner_id: userA.id,
      access_token_enc: 'v1.a.b.c',
      refresh_token_enc: 'v1.a.b.c',
      access_token_expires_at: new Date().toISOString(),
    })
    await adminClient().from('reddit_accounts').delete().eq('id', temp)
    const { data } = await adminClient()
      .from('reddit_account_secrets')
      .select('reddit_account_id')
      .eq('reddit_account_id', temp)
    expect(data).toHaveLength(0)
  })
})

describe('reddit_account_network_configs', () => {
  beforeAll(async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .insert({
        reddit_account_id: accountA,
        owner_id: userA.id,
        proxy_enabled: true,
        proxy_protocol: 'socks5',
        proxy_host: 'proxy.exemplo.com',
        proxy_port: 1080,
        proxy_username: 'usuario',
        proxy_password_enc: 'v1.ggg.hhh.iii',
      })
    if (error) throw error
  })

  it('o dono NÃO consegue ler a configuração crua pelo Data API', async () => {
    const { data, error } = await userClient(userA.accessToken)
      .from('reddit_account_network_configs')
      .select('proxy_username, proxy_password_enc, proxy_host')
    expect(data ?? []).toHaveLength(0)
    const payload = JSON.stringify({ data, error })
    expect(payload).not.toContain('usuario')
    expect(payload).not.toContain('v1.ggg')
    expect(payload).not.toContain('proxy.exemplo.com')
  })

  it('exige host, porta e protocolo quando o proxy está habilitado', async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .update({ proxy_host: null })
      .eq('reddit_account_id', accountA)
    expect(error).not.toBeNull()
  })

  it('rejeita protocolo fora da lista permitida', async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .update({ proxy_protocol: 'ftp' })
      .eq('reddit_account_id', accountA)
    expect(error).not.toBeNull()
  })

  it('rejeita porta fora da faixa válida', async () => {
    const { error } = await adminClient()
      .from('reddit_account_network_configs')
      .update({ proxy_port: 70000 })
      .eq('reddit_account_id', accountA)
    expect(error).not.toBeNull()
  })
})

describe('reddit_account_network_status (view)', () => {
  it('o dono vê o status com host mascarado', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_account_network_status')
      .select('*')
      .eq('reddit_account_id', accountA)
      .single()
    expect(data!.proxy_enabled).toBe(true)
    expect(data!.proxy_protocol).toBe('socks5')
    expect(data!.proxy_port).toBe(1080)
    expect(data!.proxy_host_masked).toBe('pr***.exemplo.com')
  })

  it('a view nunca expõe usuário, senha ou host completo', async () => {
    const { data } = await userClient(userA.accessToken)
      .from('reddit_account_network_status')
      .select('*')
      .eq('reddit_account_id', accountA)
      .single()
    const payload = JSON.stringify(data)
    expect(payload).not.toContain('usuario')
    expect(payload).not.toContain('v1.ggg')
    expect(payload).not.toContain('proxy.exemplo.com')
  })

  it('o usuário B não vê o status das contas de A', async () => {
    const { data } = await userClient(userB.accessToken)
      .from('reddit_account_network_status')
      .select('reddit_account_id')
      .eq('reddit_account_id', accountA)
    expect(data).toHaveLength(0)
  })

  it('o mascaramento em SQL bate com o de TypeScript', async () => {
    const casos = ['proxy.exemplo.com', '203.0.113.9', 'a.b', 'localhost']
    for (const host of casos) {
      const { data } = await adminClient().rpc('mask_host', { host })
      expect(data).toBe(maskHost(host))
    }
  })
})
