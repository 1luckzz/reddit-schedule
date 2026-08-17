export const POST_STATUSES = [
  'draft',
  'scheduled',
  'processing',
  'published',
  'failed',
  'cancelled',
  'needs_review',
] as const

export type PostStatus = (typeof POST_STATUSES)[number]

/** Estados em que reagendar e cancelar são possíveis — os mesmos do trigger. */
export const EDITABLE: readonly PostStatus[] = ['draft', 'scheduled']

/** Estados terminais que compõem o Histórico. */
export const HISTORY_STATUSES: readonly PostStatus[] = [
  'published',
  'failed',
  'cancelled',
]

/** Estados que ainda vão acontecer, mostrados na Fila. */
export const QUEUE_STATUSES: readonly PostStatus[] = [
  'draft',
  'scheduled',
  'processing',
  'needs_review',
]

const ROTULOS: Record<PostStatus, string> = {
  draft: 'Rascunho',
  scheduled: 'Programado',
  processing: 'Publicando agora',
  published: 'Publicado',
  failed: 'Falhou',
  cancelled: 'Cancelado',
  needs_review: 'Aguardando revisão',
}

// A linguagem de lâmpadas da sala de transmissão: texto na cor do estado,
// fundo tingido de leve e borda hairline na mesma cor. `processing` é o
// vermelho NO AR — vivo, não erro; `failed` usa o tijolo fosco de propósito,
// para nunca disputar com a lâmpada ao vivo.
const CORES: Record<PostStatus, string> = {
  draft: 'text-fosforo-dim border-fosforo-dim/30 bg-fosforo-dim/10',
  scheduled: 'text-standby border-standby/30 bg-standby/10',
  processing: 'text-noar border-noar/40 bg-noar/10',
  published: 'text-ok border-ok/30 bg-ok/10',
  failed: 'text-tijolo border-tijolo/35 bg-tijolo/10',
  cancelled: 'text-fosforo-dim/70 border-fosforo-dim/20 bg-transparent',
  needs_review: 'text-ambar border-ambar/35 bg-ambar/10',
}

export function rotuloStatus(status: string): string {
  return ROTULOS[status as PostStatus] ?? status
}

export function corStatus(status: string): string {
  return CORES[status as PostStatus] ?? CORES.draft
}

/**
 * A interface só oferece o que a máquina de estados aceita.
 *
 * Isto NÃO é a barreira — o trigger e a RPC continuam recusando de qualquer
 * forma. Serve para não oferecer um botão que vai falhar.
 */
export function podeEditar(status: string): boolean {
  return (EDITABLE as readonly string[]).includes(status)
}
