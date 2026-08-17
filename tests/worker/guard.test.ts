import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertBancoPermitido,
  DevelopmentDatabaseError,
  ehBancoDeDesenvolvimento,
  permissaoDeBancoLocal,
} from '@/lib/worker/guard'

describe('ehBancoDeDesenvolvimento', () => {
  it('reconhece loopback em todas as formas usuais', () => {
    for (const url of [
      'http://localhost:54321',
      'http://127.0.0.1:54321',
      'http://127.1.2.3:54321',
      'https://LOCALHOST:54321',
      'http://0.0.0.0:54321',
    ]) {
      expect(ehBancoDeDesenvolvimento(url), url).toBe(true)
    }
  })

  it('reconhece os nomes que o Docker usa para alcançar o host', () => {
    // Foi exatamente esta forma que passou despercebida no incidente dos
    // contêineres: `host.docker.internal` não é literalmente loopback.
    for (const url of [
      'http://host.docker.internal:54321',
      'http://gateway.docker.internal:54321',
    ]) {
      expect(ehBancoDeDesenvolvimento(url), url).toBe(true)
    }
  })

  it('reconhece as faixas privadas do IPv4', () => {
    for (const url of [
      'http://10.0.0.5:54321',
      'http://172.16.0.1:54321',
      'http://172.31.255.254:54321',
      'http://192.168.1.10:54321',
    ]) {
      expect(ehBancoDeDesenvolvimento(url), url).toBe(true)
    }
  })

  it('NÃO confunde endereços públicos parecidos com privados', () => {
    // 172.15 e 172.32 estão fora da faixa privada; 11.x e 193.x também.
    for (const url of [
      'https://172.15.0.1',
      'https://172.32.0.1',
      'https://11.0.0.1',
      'https://193.168.1.1',
    ]) {
      expect(ehBancoDeDesenvolvimento(url), url).toBe(false)
    }
  })

  it('reconhece sufixos de rede local', () => {
    for (const url of [
      'http://supabase.localhost',
      'http://db.local',
      'http://algo.internal',
    ]) {
      expect(ehBancoDeDesenvolvimento(url), url).toBe(true)
    }
  })

  it('aceita o Supabase hospedado', () => {
    expect(ehBancoDeDesenvolvimento('https://abcdefgh.supabase.co')).toBe(false)
  })

  it('URL ilegível é tratada como suspeita', () => {
    // Recusar o que não sabemos ler é melhor que publicar contra um destino
    // desconhecido.
    expect(ehBancoDeDesenvolvimento('nao-e-uma-url')).toBe(true)
    expect(ehBancoDeDesenvolvimento('')).toBe(true)
  })
})

describe('assertBancoPermitido', () => {
  it('recusa banco de desenvolvimento sem permissão explícita', () => {
    expect(() =>
      assertBancoPermitido('http://127.0.0.1:54321', false),
    ).toThrow(DevelopmentDatabaseError)
  })

  it('aceita quando a permissão é dada', () => {
    expect(() =>
      assertBancoPermitido('http://127.0.0.1:54321', true),
    ).not.toThrow()
  })

  it('nunca atrapalha um banco hospedado', () => {
    expect(() =>
      assertBancoPermitido('https://abcdefgh.supabase.co', false),
    ).not.toThrow()
  })

  it('a mensagem diz o host e como prosseguir', () => {
    try {
      assertBancoPermitido('http://host.docker.internal:54321', false)
      throw new Error('deveria ter lançado')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('host.docker.internal')
      expect(msg).toContain('worker:local')
      expect(msg).toContain('WORKER_ALLOW_LOCAL_DB')
    }
  })
})

describe('permissaoDeBancoLocal', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.WORKER_ALLOW_LOCAL_DB
    delete process.env.WORKER_ALLOW_LOCAL_DB
  })

  afterEach(() => {
    if (original === undefined) delete process.env.WORKER_ALLOW_LOCAL_DB
    else process.env.WORKER_ALLOW_LOCAL_DB = original
  })

  it('sem flag e sem variável, não há permissão', () => {
    expect(permissaoDeBancoLocal(['node', 'worker/index.ts'])).toBe(false)
  })

  it('a flag de linha de comando concede', () => {
    expect(
      permissaoDeBancoLocal(['node', 'worker/index.ts', '--allow-local-db']),
    ).toBe(true)
  })

  it('a variável concede, para o contêiner', () => {
    process.env.WORKER_ALLOW_LOCAL_DB = '1'
    expect(permissaoDeBancoLocal(['node', 'worker/index.ts'])).toBe(true)
  })

  it('qualquer valor diferente de 1 NÃO concede', () => {
    // Evita que um `WORKER_ALLOW_LOCAL_DB=false` herdado passe por permissão.
    for (const valor of ['0', 'false', 'no', '']) {
      process.env.WORKER_ALLOW_LOCAL_DB = valor
      expect(permissaoDeBancoLocal(['node', 'x']), valor).toBe(false)
    }
  })
})
