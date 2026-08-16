import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { adminClient, cleanupTestUsers, createTestUser } from './helpers'
import {
  clearNetworkConfigFor,
  clearProxyCredentialsFor,
  saveNetworkConfigFor,
} from '@/lib/reddit/network-config'
import type { VerifiedAccount } from '@/lib/auth/ownership'

let userA: { id: string; accessToken: string }
let account: VerifiedAccount

const base = {
  protocol: 'socks5' as const,
  host: 'proxy.exemplo.com',
  port: 1080,
  username: 'usuario',
}

async function lerConfig() {
  const { data } = await adminClient()
    .from('reddit_account_network_configs')
    .select('proxy_password_enc, proxy_username, proxy_host, proxy_port')
    .eq('reddit_account_id', account.id)
    .single()
  return data!
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
  userA = await createTestUser(`nc-${Date.now()}@teste.local`)

  const { data, error } = await adminClient()
    .from('reddit_accounts')
    .insert({
      owner_id: userA.id,
      reddit_user_id: `t2_nc_${Date.now()}`,
      username: 'conta_rede',
    })
    .select('id, owner_id')
    .single()
  if (error) throw error

  account = data as unknown as VerifiedAccount
})

afterAll(async () => {
  await cleanupTestUsers([userA.id])
})

describe('saveNetworkConfigFor', () => {
  it('grava a senha cifrada, nunca em claro', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    const config = await lerConfig()

    const armazenado = config.proxy_password_enc!
    expect(armazenado).not.toBe('senha-secreta')
    expect(armazenado).not.toContain('senha-secreta')
    expect(armazenado).not.toContain(
      Buffer.from('senha-secreta').toString('base64'),
    )

    const { decryptSecret } = await import('@/lib/crypto/aes-gcm')
    expect(
      decryptSecret(
        armazenado,
        `reddit_account_network_configs:proxy_password:${account.id}`,
      ),
    ).toBe('senha-secreta')
  })

  it('senha em branco mantém a senha já gravada', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    const antes = await lerConfig()

    await saveNetworkConfigFor(account, { ...base, port: 3128, password: '' })
    const depois = await lerConfig()

    expect(depois.proxy_password_enc).toBe(antes.proxy_password_enc)
    expect(depois.proxy_port).toBe(3128)
  })

  it('senha nova substitui a anterior', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-um' })
    const antes = await lerConfig()

    await saveNetworkConfigFor(account, { ...base, password: 'senha-dois' })
    const depois = await lerConfig()

    expect(depois.proxy_password_enc).not.toBe(antes.proxy_password_enc)
  })

  it('salvar atualiza os campos derivados com o host mascarado', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'x' })
    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('proxy_enabled, proxy_host_masked, proxy_protocol, proxy_port')
      .eq('id', account.id)
      .single()

    expect(data!.proxy_enabled).toBe(true)
    expect(data!.proxy_host_masked).toBe('pr***.exemplo.com')
    expect(data!.proxy_protocol).toBe('socks5')
  })
})

describe('clearProxyCredentialsFor', () => {
  it('apaga usuário e senha mantendo host, porta e protocolo', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    await clearProxyCredentialsFor(account)

    const { data } = await adminClient()
      .from('reddit_account_network_configs')
      .select(
        'proxy_username, proxy_password_enc, proxy_host, proxy_port, proxy_protocol, proxy_enabled',
      )
      .eq('reddit_account_id', account.id)
      .single()

    expect(data!.proxy_username).toBeNull()
    expect(data!.proxy_password_enc).toBeNull()
    expect(data!.proxy_host).toBe('proxy.exemplo.com')
    expect(data!.proxy_port).toBe(1080)
    expect(data!.proxy_protocol).toBe('socks5')
    expect(data!.proxy_enabled).toBe(true)
  })

  it('depois de limpar, salvar sem senha não ressuscita a antiga', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    await clearProxyCredentialsFor(account)
    await saveNetworkConfigFor(account, { ...base, username: '', password: '' })

    const config = await lerConfig()
    expect(config.proxy_password_enc).toBeNull()
    expect(config.proxy_username).toBeNull()
  })

  it('o dispatcher passa a ser montado sem credenciais', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'senha-secreta' })
    await clearProxyCredentialsFor(account)

    const { getNetworkConfig } = await import('@/lib/auth/ownership')
    const { buildProxyUrl } = await import('@/lib/reddit/reddit-client-factory')
    const config = await getNetworkConfig(account)

    expect(config).not.toBeNull()
    expect(config!.username).toBeNull()
    expect(config!.password).toBeNull()
    expect(buildProxyUrl(config!)).toBe('socks5://proxy.exemplo.com:1080')
  })
})

describe('clearNetworkConfigFor', () => {
  it('limpar a configuração zera os campos derivados', async () => {
    await saveNetworkConfigFor(account, { ...base, password: 'x' })
    await clearNetworkConfigFor(account)

    const { data } = await adminClient()
      .from('reddit_accounts')
      .select('proxy_enabled, proxy_host_masked, proxy_port, proxy_protocol')
      .eq('id', account.id)
      .single()

    expect(data!.proxy_enabled).toBe(false)
    expect(data!.proxy_host_masked).toBeNull()
    expect(data!.proxy_port).toBeNull()
    expect(data!.proxy_protocol).toBeNull()
  })

  it('sem configuração, getNetworkConfig devolve null e não há dispatcher', async () => {
    await clearNetworkConfigFor(account)

    const { getNetworkConfig } = await import('@/lib/auth/ownership')
    const { createDispatcherFor } = await import(
      '@/lib/reddit/reddit-client-factory'
    )
    const config = await getNetworkConfig(account)

    expect(config).toBeNull()
    expect(createDispatcherFor(config)).toBeUndefined()
  })
})
