import { fromUtc } from './timezone'

export type CalendarDay = {
  /** `YYYY-MM-DD` no fuso pedido. */
  date: string
  day: number
  /** Falso para os dias vizinhos que completam a primeira e a última semana. */
  inMonth: boolean
}

/**
 * Monta a grade do mês em semanas completas, de domingo a sábado.
 *
 * Trabalha inteiramente em UTC com `Date.UTC`: usar o construtor local traria
 * o fuso da máquina para dentro do cálculo, e o servidor não roda no fuso de
 * quem está olhando o calendário.
 *
 * @param month 1 a 12, como as pessoas escrevem — não 0 a 11.
 */
export function buildMonthGrid(year: number, month: number): CalendarDay[] {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('O mês precisa estar entre 1 e 12.')
  }

  const primeiro = new Date(Date.UTC(year, month - 1, 1))
  // Dia 0 do mês seguinte é o último dia deste mês; cobre bissexto sem tabela.
  const diasNoMes = new Date(Date.UTC(year, month, 0)).getUTCDate()

  const inicio = new Date(primeiro)
  inicio.setUTCDate(1 - primeiro.getUTCDay())

  const dias: CalendarDay[] = []
  const total = Math.ceil((primeiro.getUTCDay() + diasNoMes) / 7) * 7

  for (let i = 0; i < total; i++) {
    const d = new Date(inicio)
    d.setUTCDate(inicio.getUTCDate() + i)
    dias.push({
      date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate(),
      ).padStart(2, '0')}`,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month - 1 && d.getUTCFullYear() === year,
    })
  }

  return dias
}

/**
 * Agrupa publicações por dia **no fuso pedido**.
 *
 * O fuso é o do usuário, não o do servidor, e isso não é detalhe de
 * apresentação: uma publicação às 22h em São Paulo é 01h do dia seguinte em
 * UTC. Agrupar por UTC a colocaria na célula errada do calendário — um erro
 * silencioso, que só apareceria quando alguém reclamasse de não achar o post.
 */
export function groupByDay<T extends { scheduled_at: string }>(
  posts: readonly T[],
  timeZone: string,
): Map<string, T[]> {
  const mapa = new Map<string, T[]>()

  for (const post of posts) {
    const { date } = fromUtc(new Date(post.scheduled_at), timeZone)
    const atual = mapa.get(date)
    if (atual) atual.push(post)
    else mapa.set(date, [post])
  }

  return mapa
}
