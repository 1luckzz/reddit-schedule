// tests/scheduling/timezone.test.ts
import { describe, expect, it } from 'vitest'
import {
  AmbiguousTimeError,
  fromUtc,
  listOccurrences,
  NonexistentTimeError,
  SUPPORTED_TIME_ZONES,
  toUtc,
} from '@/lib/scheduling/timezone'

const SP = 'America/Sao_Paulo'
const NY = 'America/New_York'
/** Transição de 30 minutos: o caso que quebra algoritmos que somam 1 hora. */
const LORD_HOWE = 'Australia/Lord_Howe'

describe('horário normal', () => {
  it('converte horário de São Paulo para UTC', () => {
    const utc = toUtc({ date: '2026-08-16', time: '10:30', timeZone: SP })
    // São Paulo é UTC-3 o ano todo desde 2019.
    expect(utc.toISOString()).toBe('2026-08-16T13:30:00.000Z')
  })

  it('tem exatamente uma ocorrência', () => {
    const occ = listOccurrences({
      date: '2026-08-16',
      time: '10:30',
      timeZone: SP,
    })
    expect(occ).toHaveLength(1)
    expect(occ[0].offsetLabel).toBe('UTC-03:00')
  })

  it('faz round-trip preservando o horário local', () => {
    const wall = { date: '2026-08-16', time: '10:30', timeZone: SP }
    expect(fromUtc(toUtc(wall), SP)).toEqual({
      date: '2026-08-16',
      time: '10:30',
    })
  })

  it('converte meia-noite corretamente', () => {
    const utc = toUtc({ date: '2026-08-16', time: '00:00', timeZone: SP })
    expect(fromUtc(utc, SP)).toEqual({ date: '2026-08-16', time: '00:00' })
  })

  it('atravessa a virada do dia em UTC', () => {
    // 22:00 em SP é 01:00 do dia seguinte em UTC.
    const utc = toUtc({ date: '2026-08-16', time: '22:00', timeZone: SP })
    expect(utc.toISOString()).toBe('2026-08-17T01:00:00.000Z')
  })

  it('não depende do fuso da máquina que roda o código', () => {
    // fromUtc precisa usar os getters UTC sobre um instante deslocado; usar
    // getHours() traria o fuso do servidor, que no VPS não é o do usuário.
    const utc = new Date('2026-08-16T13:30:00.000Z')
    expect(fromUtc(utc, SP).time).toBe('10:30')
    expect(fromUtc(utc, 'UTC').time).toBe('13:30')
  })
})

describe('horário inexistente (relógio salta para frente)', () => {
  it('não tem nenhuma ocorrência', () => {
    // 08/03/2026 em Nova York: 02:00 vira 03:00.
    expect(
      listOccurrences({ date: '2026-03-08', time: '02:30', timeZone: NY }),
    ).toHaveLength(0)
  })

  it('recusa em vez de deslocar silenciosamente', () => {
    expect(() =>
      toUtc({ date: '2026-03-08', time: '02:30', timeZone: NY }),
    ).toThrow(NonexistentTimeError)
  })

  it('a mensagem explica o motivo em português', () => {
    try {
      toUtc({ date: '2026-03-08', time: '02:30', timeZone: NY })
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).toMatch(/não existe/i)
      expect((e as Error).message).toMatch(/horário de verão/i)
    }
  })

  it('aceita os horários vizinhos, que existem', () => {
    expect(() =>
      toUtc({ date: '2026-03-08', time: '01:30', timeZone: NY }),
    ).not.toThrow()
    expect(() =>
      toUtc({ date: '2026-03-08', time: '03:30', timeZone: NY }),
    ).not.toThrow()
  })
})

describe('horário repetido (relógio volta)', () => {
  const ambiguo = { date: '2026-11-01', time: '01:30', timeZone: NY }

  it('tem duas ocorrências', () => {
    expect(listOccurrences(ambiguo)).toHaveLength(2)
  })

  it('as ocorrências trazem offsets distintos para a UI mostrar', () => {
    const occ = listOccurrences(ambiguo)
    expect(occ[0].offsetLabel).toBe('UTC-04:00')
    expect(occ[1].offsetLabel).toBe('UTC-05:00')
  })

  it('as ocorrências estão em ordem cronológica', () => {
    const occ = listOccurrences(ambiguo)
    expect(occ[0].utc.getTime()).toBeLessThan(occ[1].utc.getTime())
  })

  it('sem escolha explícita, exige que o usuário decida', () => {
    expect(() => toUtc(ambiguo)).toThrow(AmbiguousTimeError)
  })

  it('o erro carrega as opções para o formulário exibir', () => {
    try {
      toUtc(ambiguo)
      throw new Error('deveria ter lançado')
    } catch (e) {
      const erro = e as AmbiguousTimeError
      expect(erro.occurrences).toHaveLength(2)
      expect(erro.occurrences[0].offsetLabel).toBeTruthy()
    }
  })

  it('SELEÇÃO: a primeira ocorrência é o horário de verão', () => {
    const utc = toUtc(ambiguo, { occurrence: 0 })
    expect(utc.toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('SELEÇÃO: a segunda ocorrência é o horário padrão', () => {
    const utc = toUtc(ambiguo, { occurrence: 1 })
    expect(utc.toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })

  it('as duas escolhas produzem o mesmo horário local', () => {
    // É justamente por isso que são ambíguas.
    for (const i of [0, 1]) {
      expect(fromUtc(toUtc(ambiguo, { occurrence: i }), NY).time).toBe('01:30')
    }
  })

  it('recusa índice de ocorrência fora da faixa', () => {
    expect(() => toUtc(ambiguo, { occurrence: 2 })).toThrow()
    expect(() => toUtc(ambiguo, { occurrence: -1 })).toThrow()
  })

  it('horário fora da janela ambígua tem só uma ocorrência', () => {
    expect(
      listOccurrences({ date: '2026-11-01', time: '03:30', timeZone: NY }),
    ).toHaveLength(1)
  })
})

describe('transição que NÃO é de uma hora', () => {
  // Lord Howe Island muda 30 minutos. Um algoritmo que soma 1 h erra aqui —
  // é o caso que justifica enumerar candidatos por offset.

  it('detecta horário inexistente numa transição de 30 minutos', () => {
    // 04/10/2026: 02:00 vira 02:30.
    expect(
      listOccurrences({
        date: '2026-10-04',
        time: '02:15',
        timeZone: LORD_HOWE,
      }),
    ).toHaveLength(0)
  })

  it('detecta horário repetido numa transição de 30 minutos', () => {
    // 05/04/2026: 02:00 volta para 01:30.
    expect(
      listOccurrences({
        date: '2026-04-05',
        time: '01:45',
        timeZone: LORD_HOWE,
      }),
    ).toHaveLength(2)
  })

  it('as duas ocorrências diferem em 30 minutos, não em 60', () => {
    const occ = listOccurrences({
      date: '2026-04-05',
      time: '01:45',
      timeZone: LORD_HOWE,
    })
    const diferenca = occ[1].utc.getTime() - occ[0].utc.getTime()
    expect(diferenca).toBe(30 * 60_000)
  })

  it('os offsets refletem a diferença de meia hora', () => {
    const occ = listOccurrences({
      date: '2026-04-05',
      time: '01:45',
      timeZone: LORD_HOWE,
    })
    expect(occ[0].offsetLabel).toBe('UTC+11:00')
    expect(occ[1].offsetLabel).toBe('UTC+10:30')
  })

  it('horário comum nesse fuso continua com uma ocorrência', () => {
    const occ = listOccurrences({
      date: '2026-06-10',
      time: '10:00',
      timeZone: LORD_HOWE,
    })
    expect(occ).toHaveLength(1)
    expect(occ[0].offsetLabel).toBe('UTC+10:30')
  })

  it('round-trip funciona em fuso de offset fracionário', () => {
    const wall = { date: '2026-06-10', time: '10:00', timeZone: LORD_HOWE }
    expect(fromUtc(toUtc(wall), LORD_HOWE)).toEqual({
      date: '2026-06-10',
      time: '10:00',
    })
  })
})

describe('fromUtc', () => {
  it('devolve data e hora locais no fuso pedido', () => {
    const utc = new Date('2026-08-16T13:30:00.000Z')
    expect(fromUtc(utc, SP)).toEqual({ date: '2026-08-16', time: '10:30' })
  })

  it('o mesmo instante rende horários diferentes em fusos diferentes', () => {
    const utc = new Date('2026-08-16T13:30:00.000Z')
    expect(fromUtc(utc, SP).time).toBe('10:30')
    expect(fromUtc(utc, NY).time).toBe('09:30')
  })

  it('preenche com zero à esquerda', () => {
    const utc = new Date('2026-08-16T12:05:00.000Z')
    expect(fromUtc(utc, SP)).toEqual({ date: '2026-08-16', time: '09:05' })
  })
})

describe('validação de entrada', () => {
  it('recusa fuso desconhecido', () => {
    expect(() =>
      toUtc({ date: '2026-08-16', time: '10:30', timeZone: 'Marte/Olympus' }),
    ).toThrow()
  })

  it('recusa data malformada', () => {
    expect(() =>
      toUtc({ date: '16/08/2026', time: '10:30', timeZone: SP }),
    ).toThrow()
  })

  it('recusa hora malformada', () => {
    expect(() =>
      toUtc({ date: '2026-08-16', time: '25:00', timeZone: SP }),
    ).toThrow()
  })
})

describe('SUPPORTED_TIME_ZONES', () => {
  it('inclui o padrão da spec', () => {
    expect(SUPPORTED_TIME_ZONES).toContain('America/Sao_Paulo')
  })

  it('todos os fusos são válidos para o Intl', () => {
    for (const tz of SUPPORTED_TIME_ZONES) {
      expect(() =>
        new Intl.DateTimeFormat('pt-BR', { timeZone: tz }),
      ).not.toThrow()
    }
  })
})
