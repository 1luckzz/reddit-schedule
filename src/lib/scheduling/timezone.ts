export type WallTime = {
  /** AAAA-MM-DD */
  date: string
  /** HH:MM em 24 horas */
  time: string
  timeZone: string
}

export type Occurrence = {
  utc: Date
  offsetMinutes: number
  /** Ex.: "UTC-03:00" — o que a UI mostra ao lado de cada opção. */
  offsetLabel: string
}

export class NonexistentTimeError extends Error {
  constructor(date: string, time: string, timeZone: string) {
    super(
      `O horário ${time} de ${date} não existe no fuso ${timeZone}: ` +
        'o relógio avança nesse momento por causa do horário de verão. ' +
        'Escolha outro horário.',
    )
    this.name = 'NonexistentTimeError'
  }
}

export class AmbiguousTimeError extends Error {
  readonly occurrences: Occurrence[]

  constructor(date: string, time: string, occurrences: Occurrence[]) {
    super(
      `O horário ${time} de ${date} acontece duas vezes por causa do fim do ` +
        'horário de verão. Escolha qual das ocorrências usar.',
    )
    this.name = 'AmbiguousTimeError'
    this.occurrences = occurrences
  }
}

/**
 * Fusos oferecidos no seletor. Curto de propósito: a lista completa da IANA
 * tem centenas de entradas e nenhuma serventia para este produto.
 */
export const SUPPORTED_TIME_ZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/Fortaleza',
  'America/Cuiaba',
  'America/Rio_Branco',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Berlin',
  'UTC',
] as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone })
  } catch {
    throw new Error(`Fuso horário desconhecido: ${timeZone}`)
  }
}

const dois = (n: number) => String(n).padStart(2, '0')

/** Offset do fuso, em minutos, no instante dado. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(
    dtf.formatToParts(instant).map((x) => [x.type, x.value]),
  )
  const comoUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    // Alguns locales devolvem 24 para meia-noite.
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  )
  return (comoUTC - instant.getTime()) / 60_000
}

function rotuloOffset(minutos: number): string {
  const sinal = minutos < 0 ? '-' : '+'
  const abs = Math.abs(minutos)
  return `UTC${sinal}${dois(Math.floor(abs / 60))}:${dois(abs % 60)}`
}

function validarEntrada(wall: WallTime) {
  if (!DATE_RE.test(wall.date)) throw new Error(`Data inválida: ${wall.date}`)
  if (!TIME_RE.test(wall.time)) throw new Error(`Horário inválido: ${wall.time}`)
  assertTimeZone(wall.timeZone)
}

/**
 * Lista os instantes UTC que correspondem ao horário local informado.
 *
 * Devolve 0 (horário não existe), 1 (comum) ou 2 (ocorre duas vezes).
 *
 * NÃO pressupõe que a transição de fuso seja de uma hora: Lord Howe Island
 * muda 30 minutos, e mudanças históricas de offset têm valores arbitrários.
 * Em vez de somar uma duração fixa, o algoritmo enumera candidatos a partir
 * dos offsets vigentes antes e depois do dia, e mantém apenas os que são
 * consistentes consigo mesmos.
 */
export function listOccurrences(wall: WallTime): Occurrence[] {
  validarEntrada(wall)

  const [ano, mes, dia] = wall.date.split('-').map(Number)
  const [hora, minuto] = wall.time.split(':').map(Number)
  const comoUTC = Date.UTC(ano, mes - 1, dia, hora, minuto, 0)

  const candidatosDeOffset = [
    offsetMinutes(new Date(comoUTC - 86_400_000), wall.timeZone),
    offsetMinutes(new Date(comoUTC + 86_400_000), wall.timeZone),
  ]

  const encontrados: Occurrence[] = []

  for (const offset of candidatosDeOffset) {
    const candidato = new Date(comoUTC - offset * 60_000)
    // Consistência: o offset real naquele instante precisa ser o mesmo usado
    // para calculá-lo. Se não for, o horário local não existe por esse
    // caminho.
    if (offsetMinutes(candidato, wall.timeZone) !== offset) continue
    if (encontrados.some((o) => o.utc.getTime() === candidato.getTime())) {
      continue
    }
    encontrados.push({
      utc: candidato,
      offsetMinutes: offset,
      offsetLabel: rotuloOffset(offset),
    })
  }

  return encontrados.sort((a, b) => a.utc.getTime() - b.utc.getTime())
}

/**
 * Converte data e hora locais para o instante UTC.
 *
 * - Horário inexistente: lança `NonexistentTimeError`. Deslocar em silêncio
 *   publicaria em hora diferente da combinada sem ninguém saber.
 * - Horário ambíguo sem escolha explícita: lança `AmbiguousTimeError` com as
 *   duas opções, para a UI pedir a decisão ao usuário.
 */
export function toUtc(wall: WallTime, opts: { occurrence?: number } = {}): Date {
  const ocorrencias = listOccurrences(wall)

  if (ocorrencias.length === 0) {
    throw new NonexistentTimeError(wall.date, wall.time, wall.timeZone)
  }

  if (ocorrencias.length === 1) return ocorrencias[0].utc

  const escolhida = opts.occurrence
  if (escolhida === undefined) {
    throw new AmbiguousTimeError(wall.date, wall.time, ocorrencias)
  }
  if (escolhida < 0 || escolhida >= ocorrencias.length) {
    throw new Error(`Ocorrência inválida: ${escolhida}`)
  }

  return ocorrencias[escolhida].utc
}

/**
 * Converte um instante UTC para data e hora locais no fuso pedido.
 *
 * Usa os getters `getUTC*` sobre um instante já deslocado — usar `getHours()`
 * traria o fuso da máquina, e o worker no VPS não roda no fuso do usuário.
 */
export function fromUtc(
  utc: Date,
  timeZone: string,
): { date: string; time: string } {
  assertTimeZone(timeZone)
  const deslocado = new Date(utc.getTime() + offsetMinutes(utc, timeZone) * 60_000)
  return {
    date: `${deslocado.getUTCFullYear()}-${dois(
      deslocado.getUTCMonth() + 1,
    )}-${dois(deslocado.getUTCDate())}`,
    time: `${dois(deslocado.getUTCHours())}:${dois(deslocado.getUTCMinutes())}`,
  }
}
