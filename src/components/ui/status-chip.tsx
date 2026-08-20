import { corStatus, rotuloStatus } from '@/lib/scheduling/status'

/**
 * O chip de estado do painel inteiro: tratamento cinza uniforme, com o
 * estado indicado apenas pelo ponto dessaturado e pelo rótulo. A impressão
 * geral da tela permanece preto e branco.
 */
export function StatusChip({
  status,
  rotulo,
}: {
  status: string
  /** Rótulo derivado (ex.: caminho Devvit); o ponto continua vindo do status. */
  rotulo?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-traco bg-white/5 px-2 py-0.5 text-xs text-medio">
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${corStatus(status)}`}
      />
      {rotulo ?? rotuloStatus(status)}
    </span>
  )
}
