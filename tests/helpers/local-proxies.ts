import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createTcpServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'
import selfsigned from 'selfsigned'

export type LocalProxy = {
  port: number
  /** Destinos que efetivamente passaram por este proxy. */
  seen: string[]
  close: () => Promise<void>
}

/**
 * Marca que o proxy HTTP/HTTPS injeta na requisição encaminhada. O servidor
 * alvo só responde 200 se ela chegar — é assim que provamos travessia, e não
 * apenas "a requisição deu certo".
 */
export const PROXY_MARK_HEADER = 'x-via-local-proxy'

function handleAbsoluteUri(seen: string[], mark: string) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const alvo = new URL(req.url ?? '')
    seen.push(`${alvo.hostname}:${alvo.port || 80}`)

    const upstream = connect(Number(alvo.port || 80), alvo.hostname, () => {
      upstream.write(
        `${req.method} ${alvo.pathname}${alvo.search} HTTP/1.1\r\n` +
          `host: ${alvo.host}\r\n` +
          `${PROXY_MARK_HEADER}: ${mark}\r\n` +
          `connection: close\r\n\r\n`,
      )
      req.pipe(upstream)
    })
    upstream.on('data', (chunk) => res.socket?.write(chunk))
    upstream.on('end', () => res.socket?.end())
    upstream.on('error', () => res.socket?.destroy())
  }
}

/** Proxy HTTP: encaminha requisições de URI absoluto, injetando a marca. */
export async function startHttpProxy(mark = 'http'): Promise<LocalProxy> {
  const seen: string[] = []
  const server: Server = createHttpServer(handleAbsoluteUri(seen, mark))

  server.listen(0)
  await once(server, 'listening')

  return {
    port: (server.address() as { port: number }).port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** Certificado auto-assinado para o proxy HTTPS. `generate` é assíncrono na v5. */
export async function generateCert() {
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      // A v5 trocou `days` por notBeforeDate/notAfterDate.
      notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      keySize: 2048,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    },
  )
  return { key: pems.private, cert: pems.cert }
}

/**
 * Proxy HTTPS: o túnel até o proxy é TLS. O tráfego encaminhado continua
 * sendo HTTP simples até o alvo de teste.
 */
export async function startHttpsProxy(
  mark = 'https',
): Promise<LocalProxy & { ca: string }> {
  const seen: string[] = []
  const { key, cert } = await generateCert()
  const server = createHttpsServer({ key, cert }, handleAbsoluteUri(seen, mark))

  server.listen(0)
  await once(server, 'listening')

  return {
    port: (server.address() as { port: number }).port,
    seen,
    ca: cert,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/**
 * Proxy SOCKS5 mínimo (RFC 1928), apenas o necessário para CONNECT sem
 * autenticação: greeting, request e repasse do fluxo TCP.
 *
 * SOCKS5 opera na camada TCP, então não há como injetar header HTTP. A prova
 * de travessia aqui é o registro do destino em `seen`, combinada com o
 * controle negativo (sem dispatcher, nada é registrado).
 */
export async function startSocks5Proxy(): Promise<LocalProxy> {
  const seen: string[] = []

  const server = createTcpServer((client: Socket) => {
    let etapa: 'greeting' | 'request' | 'pipe' = 'greeting'

    client.on('data', (chunk) => {
      if (etapa === 'greeting') {
        // 0x05 <nmethods> <methods...>  ->  0x05 0x00 (sem autenticação)
        client.write(Buffer.from([0x05, 0x00]))
        etapa = 'request'
        return
      }

      if (etapa === 'request') {
        // 0x05 0x01 0x00 <atyp> <addr> <port>
        const atyp = chunk[3]
        let host: string
        let offset: number

        if (atyp === 0x01) {
          host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const len = chunk[4]
          host = chunk.subarray(5, 5 + len).toString('utf8')
          offset = 5 + len
        } else {
          client.destroy()
          return
        }

        const port = chunk.readUInt16BE(offset)
        seen.push(`${host}:${port}`)

        const upstream = connect(port, host, () => {
          // 0x05 0x00 0x00 0x01 0.0.0.0 0
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          etapa = 'pipe'
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.destroy())
      }
    })

    client.on('error', () => client.destroy())
  })

  server.listen(0)
  await once(server, 'listening')

  return {
    port: (server.address() as { port: number }).port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/**
 * Servidor alvo. Responde 200 apenas quando a requisição chega com a marca do
 * proxy; sem ela, responde 418. Assim, uma conexão direta é detectável pelo
 * status, não só pela ausência de registro no proxy.
 */
export async function startTargetServer(opts: { requireMark: boolean }) {
  const hits: { viaProxy: string | undefined }[] = []

  const server = createHttpServer((req, res) => {
    const mark = req.headers[PROXY_MARK_HEADER] as string | undefined
    hits.push({ viaProxy: mark })

    if (opts.requireMark && !mark) {
      res.writeHead(418, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ erro: 'chegou sem passar pelo proxy' }))
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, viaProxy: mark ?? null }))
  })

  server.listen(0)
  await once(server, 'listening')

  return {
    port: (server.address() as { port: number }).port,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
