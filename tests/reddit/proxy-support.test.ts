import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetch } from 'undici'
import { createDispatcherFor } from '@/lib/reddit/reddit-client-factory'
import {
  isExperimentalProtocol,
  SUPPORTED_PROXY_PROTOCOLS,
} from '@/lib/reddit/proxy-support'
import {
  startHttpProxy,
  startHttpsProxy,
  startSocks5Proxy,
  startTargetServer,
} from '../helpers/local-proxies'

let alvo: Awaited<ReturnType<typeof startTargetServer>>

beforeAll(async () => {
  // requireMark: o alvo devolve 418 se a requisição chegar sem a marca do
  // proxy. Um fallback silencioso para conexão direta vira falha explícita.
  alvo = await startTargetServer({ requireMark: true })
})

afterAll(async () => {
  await alvo.close()
})

const baseConfig = {
  enabled: true as const,
  host: '127.0.0.1',
  username: null,
  password: null,
}

describe('diagnóstico de versões do undici', () => {
  it('registra a versão bundled e a instalada', async () => {
    const instalada = (await import('undici/package.json', {
      with: { type: 'json' },
    })) as unknown as { default: { version: string } }

    // Não são a mesma instância: dispatcher de uma não funciona no fetch da
    // outra. Por isso fetch e ProxyAgent vêm ambos do pacote instalado.
    expect(typeof process.versions.undici).toBe('string')
    expect(typeof instalada.default.version).toBe('string')
  })
})

describe('proxy HTTP', () => {
  it('o tráfego atravessa o proxy e chega marcado ao alvo', async () => {
    const proxy = await startHttpProxy('http')
    try {
      const dispatcher = createDispatcherFor({
        ...baseConfig,
        protocol: 'http',
        port: proxy.port,
      })

      const res = await fetch(`http://127.0.0.1:${alvo.port}/teste`, {
        dispatcher,
      })
      const corpo = (await res.json()) as { ok: boolean; viaProxy: string }

      expect(res.status).toBe(200)
      expect(corpo.viaProxy).toBe('http')
      expect(proxy.seen).toContain(`127.0.0.1:${alvo.port}`)
    } finally {
      await proxy.close()
    }
  })

  it('controle negativo: sem dispatcher, o proxy não registra nada', async () => {
    const proxy = await startHttpProxy('http')
    try {
      const res = await fetch(`http://127.0.0.1:${alvo.port}/direto`)
      // O alvo recusa conexão direta, provando que a marca não veio.
      expect(res.status).toBe(418)
      expect(proxy.seen).toHaveLength(0)
    } finally {
      await proxy.close()
    }
  })

  it('sem fallback: proxy fora do ar faz a requisição falhar', async () => {
    const proxy = await startHttpProxy('http')
    const porta = proxy.port
    await proxy.close()

    const dispatcher = createDispatcherFor({
      ...baseConfig,
      protocol: 'http',
      port: porta,
    })

    // Se houvesse fallback para conexão direta, isto teria sucesso.
    await expect(
      fetch(`http://127.0.0.1:${alvo.port}/teste`, { dispatcher }),
    ).rejects.toBeTruthy()
  })
})

describe('proxy HTTPS', () => {
  it('o tráfego atravessa o proxy e chega marcado ao alvo', async () => {
    const proxy = await startHttpsProxy('https')
    try {
      const dispatcher = createDispatcherFor(
        { ...baseConfig, protocol: 'https', port: proxy.port },
        { proxyTls: { ca: proxy.ca } },
      )

      const res = await fetch(`http://127.0.0.1:${alvo.port}/teste`, {
        dispatcher,
      })
      const corpo = (await res.json()) as { ok: boolean; viaProxy: string }

      expect(res.status).toBe(200)
      expect(corpo.viaProxy).toBe('https')
      expect(proxy.seen).toContain(`127.0.0.1:${alvo.port}`)
    } finally {
      await proxy.close()
    }
  })

  it('controle negativo: sem dispatcher, o proxy não registra nada', async () => {
    const proxy = await startHttpsProxy('https')
    try {
      const res = await fetch(`http://127.0.0.1:${alvo.port}/direto`)
      expect(res.status).toBe(418)
      expect(proxy.seen).toHaveLength(0)
    } finally {
      await proxy.close()
    }
  })

  it('sem fallback: proxy fora do ar faz a requisição falhar', async () => {
    const proxy = await startHttpsProxy('https')
    const porta = proxy.port
    const ca = proxy.ca
    await proxy.close()

    const dispatcher = createDispatcherFor(
      { ...baseConfig, protocol: 'https', port: porta },
      { proxyTls: { ca } },
    )

    await expect(
      fetch(`http://127.0.0.1:${alvo.port}/teste`, { dispatcher }),
    ).rejects.toBeTruthy()
  })
})

describe('proxy SOCKS5', () => {
  it('o tráfego atravessa o proxy, registrado no handshake', async () => {
    const proxy = await startSocks5Proxy()
    try {
      const dispatcher = createDispatcherFor({
        ...baseConfig,
        protocol: 'socks5',
        port: proxy.port,
      })

      // SOCKS5 opera em TCP e não injeta header, então o alvo é consultado
      // sem exigir marca. A prova de travessia é o destino registrado no
      // handshake do proxy, mais o controle negativo abaixo.
      const semMarca = await startTargetServer({ requireMark: false })
      try {
        const res = await fetch(`http://127.0.0.1:${semMarca.port}/teste`, {
          dispatcher,
        })
        expect(res.status).toBe(200)
        expect(proxy.seen).toContain(`127.0.0.1:${semMarca.port}`)
      } finally {
        await semMarca.close()
      }
    } finally {
      await proxy.close()
    }
  })

  it('controle negativo: sem dispatcher, o proxy não registra nada', async () => {
    const proxy = await startSocks5Proxy()
    const semMarca = await startTargetServer({ requireMark: false })
    try {
      const res = await fetch(`http://127.0.0.1:${semMarca.port}/direto`)
      expect(res.status).toBe(200)
      // O destino não passou pelo proxy: nada foi registrado no handshake.
      expect(proxy.seen).toHaveLength(0)
    } finally {
      await semMarca.close()
      await proxy.close()
    }
  })

  it('sem fallback: proxy fora do ar faz a requisição falhar', async () => {
    const proxy = await startSocks5Proxy()
    const porta = proxy.port
    await proxy.close()

    const dispatcher = createDispatcherFor({
      ...baseConfig,
      protocol: 'socks5',
      port: porta,
    })

    await expect(
      fetch(`http://127.0.0.1:${alvo.port}/teste`, { dispatcher }),
    ).rejects.toBeTruthy()
  })
})

describe('lista de protocolos oferecidos ao usuário', () => {
  it('só contém protocolos com travessia comprovada nesta suíte', () => {
    // Se algum describe acima for removido ou marcado como skip, este teste
    // precisa ser atualizado junto — e o protocolo, retirado do produto.
    expect([...SUPPORTED_PROXY_PROTOCOLS].sort()).toEqual([
      'http',
      'https',
      'socks5',
    ])
  })

  it('socks5 está marcado como experimental', () => {
    // O undici emite ExperimentalWarning para SOCKS5: funciona hoje, mas pode
    // mudar sem aviso de breaking change. A UI precisa avisar o usuário.
    expect(isExperimentalProtocol('socks5')).toBe(true)
    expect(isExperimentalProtocol('http')).toBe(false)
    expect(isExperimentalProtocol('https')).toBe(false)
  })
})
