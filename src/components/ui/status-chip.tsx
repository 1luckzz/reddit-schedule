import { corStatus, rotuloStatus } from '@/lib/scheduling/status'

/**
 * Cor da lâmpada por estado. `processing` pulsa (classe lampada-noar):
 * é o único movimento da interface, reservado para o que está NO AR.
 * `failed` fica sem brilho de propósito — tijolo fosco, nunca lâmpada.
 */
const LAMPADA: Record<string, string> = {
  draft: 'bg-fosforo-dim',
  scheduled: 'bg-standby',
  processing: 'bg-noar lampada-noar',
  published: 'bg-ok',
  failed: 'bg-tijolo',
  cancelled: 'bg-fosforo-dim/50',
  needs_review: 'bg-ambar',
}

/** O chip de estado usado no painel inteiro: lâmpada + rótulo gravado. */
export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-display text-[11px] font-medium uppercase tracking-[0.08em] whitespace-nowrap ${corStatus(status)}`}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${LAMPADA[status] ?? 'bg-fosforo-dim'}`}
      />
      {rotuloStatus(status)}
    </span>
  )
}
