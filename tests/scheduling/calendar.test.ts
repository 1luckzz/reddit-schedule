import { describe, expect, it } from 'vitest'
import { buildMonthGrid, groupByDay } from '@/lib/scheduling/calendar'

describe('buildMonthGrid', () => {
  it('a grade começa no domingo e termina no sábado', () => {
    const grade = buildMonthGrid(2026, 8)
    expect(grade.length % 7).toBe(0)

    const primeiro = new Date(`${grade[0].date}T00:00:00Z`)
    const ultimo = new Date(`${grade[grade.length - 1].date}T00:00:00Z`)
    expect(primeiro.getUTCDay()).toBe(0)
    expect(ultimo.getUTCDay()).toBe(6)
  })

  it('cobre todos os dias do mês', () => {
    const grade = buildMonthGrid(2026, 8)
    const doMes = grade.filter((d) => d.inMonth).map((d) => d.day)
    expect(doMes).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
  })

  it('marca os dias de outros meses', () => {
    const grade = buildMonthGrid(2026, 8)
    const fora = grade.filter((d) => !d.inMonth)
    expect(fora.length).toBeGreaterThan(0)
    for (const d of fora) {
      expect(d.date.slice(0, 7)).not.toBe('2026-08')
    }
  })

  it('fevereiro de ano bissexto tem 29 dias', () => {
    const grade = buildMonthGrid(2024, 2)
    expect(grade.filter((d) => d.inMonth)).toHaveLength(29)
    expect(grade.some((d) => d.inMonth && d.day === 29)).toBe(true)
  })

  it('fevereiro comum tem 28 dias', () => {
    expect(buildMonthGrid(2026, 2).filter((d) => d.inMonth)).toHaveLength(28)
  })

  it('mês que começa no domingo não ganha semana vazia à frente', () => {
    // Fevereiro de 2026 começa num domingo.
    const grade = buildMonthGrid(2026, 2)
    expect(grade[0].date).toBe('2026-02-01')
    expect(grade[0].inMonth).toBe(true)
  })

  it('a virada de ano aparece corretamente', () => {
    const grade = buildMonthGrid(2026, 12)
    expect(grade.filter((d) => d.inMonth)).toHaveLength(31)
    // Os dias seguintes pertencem a janeiro do ano seguinte.
    const depois = grade[grade.length - 1]
    expect(depois.date.startsWith('2027-01') || depois.inMonth).toBe(true)
  })

  it('recusa mês fora de 1 a 12', () => {
    for (const m of [0, 13, -1, 1.5]) {
      expect(() => buildMonthGrid(2026, m), String(m)).toThrow(RangeError)
    }
  })
})

describe('groupByDay', () => {
  const post = (iso: string, id = 'p1') => ({ id, scheduled_at: iso })

  it('agrupa 22h em São Paulo no dia certo, não no seguinte', () => {
    // 2026-09-01T22:00 em São Paulo é 2026-09-02T01:00Z. Agrupar por UTC
    // colocaria a publicação no dia 2 do calendário.
    const mapa = groupByDay(
      [post('2026-09-02T01:00:00.000Z')],
      'America/Sao_Paulo',
    )
    expect([...mapa.keys()]).toEqual(['2026-09-01'])
  })

  it('a mesma publicação cai em dias diferentes conforme o fuso', () => {
    const instante = post('2026-09-02T01:00:00.000Z')
    expect([...groupByDay([instante], 'America/Sao_Paulo').keys()]).toEqual([
      '2026-09-01',
    ])
    expect([...groupByDay([instante], 'UTC').keys()]).toEqual(['2026-09-02'])
    expect([...groupByDay([instante], 'Asia/Tokyo').keys()]).toEqual([
      '2026-09-02',
    ])
  })

  it('junta várias publicações do mesmo dia', () => {
    const mapa = groupByDay(
      [
        post('2026-09-01T13:00:00.000Z', 'a'),
        post('2026-09-01T20:00:00.000Z', 'b'),
      ],
      'America/Sao_Paulo',
    )
    expect(mapa.get('2026-09-01')?.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('dia sem publicação simplesmente não está no mapa', () => {
    const mapa = groupByDay([post('2026-09-01T13:00:00.000Z')], 'UTC')
    // Quem consulta usa `?? []`; o mapa não inventa dias vazios.
    expect(mapa.get('2026-09-05')).toBeUndefined()
    expect(mapa.get('2026-09-05') ?? []).toEqual([])
  })

  it('lista vazia devolve mapa vazio', () => {
    expect(groupByDay([], 'UTC').size).toBe(0)
  })

  it('recusa fuso fora da lista suportada', () => {
    expect(() =>
      groupByDay([post('2026-09-01T13:00:00.000Z')], 'Marte/Olympus'),
    ).toThrow()
  })
})
