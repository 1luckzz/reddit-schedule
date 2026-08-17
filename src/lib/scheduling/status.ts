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

// O ponto de estado do tema Grafite: o chip é sempre cinza, e o estado
// aparece só neste ponto, em tom dessaturado. `processing` é o único que se
// move — um ponto branco pulsando devagar.
const CORES: Record<PostStatus, string> = {
  draft: 'bg-fraco',
  scheduled: 'bg-aco',
  processing: 'bg-forte pulso-suave',
  published: 'bg-salvia',
  failed: 'bg-rosa',
  cancelled: 'bg-fraco/60',
  needs_review: 'bg-areia',
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
