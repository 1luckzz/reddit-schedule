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

const CORES: Record<PostStatus, string> = {
  draft:
    'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  scheduled: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  processing:
    'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  published:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  cancelled:
    'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
  needs_review:
    'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
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
