export class DevelopmentDatabaseError extends Error {
  constructor(host: string) {
    super(
      `O worker foi apontado para um banco de desenvolvimento (${host}).\n` +
        '\n' +
        'Este é o mesmo banco que a suíte de testes usa. Um worker rodando\n' +
        'contra ele reivindica os jobs dos testes e produz falhas\n' +
        'intermitentes difíceis de rastrear.\n' +
        '\n' +
        'Se a intenção é mesmo essa, torne-a explícita:\n' +
        '  npm run worker:local\n' +
        '  ou WORKER_ALLOW_LOCAL_DB=1 no ambiente do contêiner.',
    )
    this.name = 'DevelopmentDatabaseError'
  }
}

/** 10/8, 172.16/12 e 192.168/16 — as faixas privadas do IPv4. */
function ehIpPrivado(host: string): boolean {
  const partes = host.split('.')
  if (partes.length !== 4) return false
  const [a, b] = partes.map(Number)
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false

  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/**
 * Reconhece um stack de desenvolvimento pela URL.
 *
 * O Supabase hospedado responde em `<ref>.supabase.co`; qualquer coisa em
 * loopback, rede privada ou nos nomes que o Docker usa para alcançar a
 * máquina do desenvolvedor é, na prática, o ambiente local — o mesmo que a
 * suíte de testes usa.
 *
 * O teste é sobre o HOST e não sobre a porta: o stack local também roda em
 * portas variadas, e depender de `54321` daria falsa sensação de proteção.
 */
export function ehBancoDeDesenvolvimento(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // URL ilegível: tratada como suspeita. Recusar algo que não sabemos ler é
    // melhor que publicar contra um destino desconhecido.
    return true
  }

  // Colchetes de IPv6 já saem removidos por `hostname`.
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  if (host.startsWith('127.')) return true
  if (host === 'host.docker.internal' || host === 'gateway.docker.internal') {
    return true
  }
  if (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true
  }
  return ehIpPrivado(host)
}

/**
 * Barra a combinação acidental de worker com o banco dos testes.
 *
 * Não impede o uso legítimo — desenvolver o worker contra o stack local é
 * normal. O que ele exige é que essa escolha seja **deliberada**, feita no
 * momento da execução, e não herdada de um arquivo de ambiente ou de um
 * contêiner esquecido rodando.
 */
export function assertBancoPermitido(url: string, permitido: boolean): void {
  if (permitido) return
  if (!ehBancoDeDesenvolvimento(url)) return
  throw new DevelopmentDatabaseError(new URL(url).hostname)
}

/**
 * Lê a permissão do ambiente e da linha de comando.
 *
 * A flag existe para o desenvolvedor (visível a cada execução, impossível de
 * esquecer em um arquivo); a variável existe para o contêiner, que não tem
 * como receber argumentos com a mesma facilidade.
 */
export function permissaoDeBancoLocal(argv: string[] = process.argv): boolean {
  if (argv.includes('--allow-local-db')) return true
  return process.env.WORKER_ALLOW_LOCAL_DB === '1'
}
