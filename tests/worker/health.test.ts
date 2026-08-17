import { describe, expect, it } from 'vitest'
import {
  avaliarSaude,
  corteDeAtraso,
  LIMITE_INATIVIDADE_MINUTOS,
  TOLERANCIA_ATRASO_MINUTOS,
} from '@/lib/worker/health'

const agora = new Date('2026-09-01T12:00:00.000Z')
const minutosAtras = (n: number) => new Date(agora.getTime() - n * 60_000)

describe('avaliarSaude', () => {
  it('publicação vencida na fila significa worker parado', () => {
    // O sinal confiável: ela deveria ter saído.
    const s = avaliarSaude({
      ultimaAtividade: minutosAtras(1),
      atrasadas: 3,
      agora,
    })
    expect(s.parado).toBe(true)
    expect(s.atrasadas).toBe(3)
  })

  it('sem publicação vencida, o worker NÃO é dado como parado', () => {
    const s = avaliarSaude({ ultimaAtividade: null, atrasadas: 0, agora })
    expect(s.parado).toBe(false)
  })

  it('silêncio prolongado é ociosidade, não falha', () => {
    // Sem nada agendado o worker não registra nada. Tratar isso como falha
    // encheria a tela de alarme falso.
    const s = avaliarSaude({
      ultimaAtividade: minutosAtras(600),
      atrasadas: 0,
      agora,
    })
    expect(s.ocioso).toBe(true)
    expect(s.parado).toBe(false)
  })

  it('nunca ter registrado nada conta como ocioso', () => {
    const s = avaliarSaude({ ultimaAtividade: null, atrasadas: 0, agora })
    expect(s.ocioso).toBe(true)
    expect(s.minutosDesdeAtividade).toBeNull()
  })

  it('atividade recente não é ociosidade', () => {
    const s = avaliarSaude({
      ultimaAtividade: minutosAtras(LIMITE_INATIVIDADE_MINUTOS - 1),
      atrasadas: 0,
      agora,
    })
    expect(s.ocioso).toBe(false)
  })

  it('a fronteira da ociosidade é exatamente o limite', () => {
    const noLimite = avaliarSaude({
      ultimaAtividade: minutosAtras(LIMITE_INATIVIDADE_MINUTOS),
      atrasadas: 0,
      agora,
    })
    const passandoDoLimite = avaliarSaude({
      ultimaAtividade: minutosAtras(LIMITE_INATIVIDADE_MINUTOS + 1),
      atrasadas: 0,
      agora,
    })
    expect(noLimite.ocioso).toBe(false)
    expect(passandoDoLimite.ocioso).toBe(true)
  })

  it('parado e ocioso são independentes', () => {
    // Um worker que morreu logo depois de publicar está parado sem estar
    // ocioso; a tela precisa dizer "parado", que é o que importa.
    const s = avaliarSaude({
      ultimaAtividade: minutosAtras(1),
      atrasadas: 2,
      agora,
    })
    expect(s.parado).toBe(true)
    expect(s.ocioso).toBe(false)
  })

  it('calcula os minutos desde a última atividade', () => {
    const s = avaliarSaude({
      ultimaAtividade: minutosAtras(42),
      atrasadas: 0,
      agora,
    })
    expect(s.minutosDesdeAtividade).toBe(42)
  })
})

describe('corteDeAtraso', () => {
  it('dá folga de um ciclo antes de acusar atraso', () => {
    // Uma publicação vencida há trinta segundos pode estar apenas esperando o
    // próximo ciclo; sem folga, todo agendamento viraria alarme.
    const corte = corteDeAtraso(agora)
    expect((agora.getTime() - corte.getTime()) / 60_000).toBe(
      TOLERANCIA_ATRASO_MINUTOS,
    )
  })

  it('a folga é pequena o bastante para não esconder falha real', () => {
    expect(TOLERANCIA_ATRASO_MINUTOS).toBeLessThanOrEqual(10)
  })
})
