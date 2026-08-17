/** Sem atividade além disso, o worker é considerado ocioso. */
export const LIMITE_INATIVIDADE_MINUTOS = 15

/**
 * Folga antes de considerar uma publicação atrasada.
 *
 * O worker roda em ciclos; uma publicação vencida há trinta segundos pode
 * simplesmente estar esperando o próximo ciclo. Sem essa folga, o painel
 * acusaria falha a cada agendamento que vence.
 */
export const TOLERANCIA_ATRASO_MINUTOS = 5

export type WorkerHealth = {
  /** Verdadeiro só quando há evidência concreta de que o worker não roda. */
  parado: boolean
  /** Sem atividade recente — o que, sozinho, NÃO significa falha. */
  ocioso: boolean
  atrasadas: number
  minutosDesdeAtividade: number | null
}

/**
 * Avalia a saúde do worker a partir do que o painel consegue ver.
 *
 * A distinção entre `parado` e `ocioso` é o ponto todo desta função. Um worker
 * sem nada para fazer não registra nada, e tratar silêncio como falha encheria
 * a tela de alarme falso. O sinal confiável é outro: publicações que já
 * venceram e continuam na fila deveriam ter saído — se não saíram, alguém
 * precisa saber.
 *
 * Recebe `agora` em vez de ler o relógio: assim a lógica é determinística e
 * testável, e o componente que a usa continua puro.
 */
export function avaliarSaude(entrada: {
  ultimaAtividade: Date | null
  atrasadas: number
  agora: Date
}): WorkerHealth {
  const { ultimaAtividade, atrasadas, agora } = entrada

  const minutosDesdeAtividade = ultimaAtividade
    ? Math.floor((agora.getTime() - ultimaAtividade.getTime()) / 60_000)
    : null

  return {
    parado: atrasadas > 0,
    ocioso:
      minutosDesdeAtividade === null ||
      minutosDesdeAtividade > LIMITE_INATIVIDADE_MINUTOS,
    atrasadas,
    minutosDesdeAtividade,
  }
}

/** Instante a partir do qual uma publicação vencida conta como atrasada. */
export function corteDeAtraso(agora: Date): Date {
  return new Date(agora.getTime() - TOLERANCIA_ATRASO_MINUTOS * 60_000)
}
