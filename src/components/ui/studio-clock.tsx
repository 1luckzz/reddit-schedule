'use client'

import { useEffect, useState } from 'react'

/**
 * O relógio de estúdio da linha de transmissão.
 *
 * Renderiza `--:--:--` no servidor e só começa a marcar no cliente: o
 * primeiro tick vem de um setTimeout(0) — nunca de um setState síncrono no
 * corpo do effect — para não haver divergência de hidratação nem violação
 * da regra set-state-in-effect.
 */
export function StudioClock({ timeZone }: { timeZone: string }) {
  const [agora, setAgora] = useState<Date | null>(null)

  useEffect(() => {
    const tick = () => setAgora(new Date())
    const primeiro = setTimeout(tick, 0)
    const intervalo = setInterval(tick, 1000)
    return () => {
      clearTimeout(primeiro)
      clearInterval(intervalo)
    }
  }, [])

  const texto = agora
    ? new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone,
      }).format(agora)
    : '--:--:--'

  return (
    <time
      aria-label={`Hora atual em ${timeZone}`}
      className="font-mono text-sm tabular-nums text-fosforo"
    >
      {texto}
    </time>
  )
}
