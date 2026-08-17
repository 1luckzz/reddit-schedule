import type { RedditClient } from './client'

/** Tolerância em torno do horário da tentativa, em segundos. */
const JANELA_SEGUNDOS = 3600

export type ReconcileTarget = {
  username: string
  subredditName: string
  title: string
  attemptedAt: Date
}

export type Candidate = {
  redditPostId: string
  redditFullname: string
  title: string
  permalink: string
  createdAt: Date
}

type Listing = {
  data?: {
    children?: { kind?: string; data?: Record<string, unknown> }[]
  }
}

const normalizar = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Procura publicações que possam corresponder a um job com resultado
 * desconhecido.
 *
 * É SEMPRE uma leitura. Não reenvia nada, não altera nada, e não decide: quem
 * confirma o vínculo é a pessoa, na página de Revisão. Por isso a função
 * devolve uma lista, mesmo quando há um único candidato óbvio — e devolve
 * todos quando há vários, porque dois compatíveis significam ou publicação
 * duplicada ou homônimos, e nenhum dos dois casos se resolve por heurística.
 *
 * Erros da API sobem em vez de virar lista vazia: "não consegui consultar" e
 * "consultei e não achei" levam a decisões opostas, e confundi-los faria a
 * pessoa marcar como falho algo que está publicado.
 */
export async function findCandidates(
  client: RedditClient,
  alvo: ReconcileTarget,
): Promise<Candidate[]> {
  const { data } = await client.request<Listing>({
    path: `/user/${alvo.username}/submitted`,
    query: { limit: '25', sort: 'new' },
  })

  const tituloAlvo = normalizar(alvo.title)
  const inicio = alvo.attemptedAt.getTime() - JANELA_SEGUNDOS * 1000
  const fim = alvo.attemptedAt.getTime() + JANELA_SEGUNDOS * 1000

  const encontrados: Candidate[] = []

  for (const child of data?.data?.children ?? []) {
    if (child.kind !== 't3' || !child.data) continue
    const d = child.data

    const subreddit = typeof d.subreddit === 'string' ? d.subreddit : ''
    const titulo = typeof d.title === 'string' ? d.title : ''
    const criado =
      typeof d.created_utc === 'number' ? d.created_utc * 1000 : null
    const fullname = typeof d.name === 'string' ? d.name : null
    const id = typeof d.id === 'string' ? d.id : null

    if (!fullname || !id || criado === null) continue
    if (subreddit.toLowerCase() !== alvo.subredditName.toLowerCase()) continue
    if (normalizar(titulo) !== tituloAlvo) continue
    if (criado < inicio || criado > fim) continue

    const permalink =
      typeof d.permalink === 'string'
        ? `https://www.reddit.com${d.permalink}`
        : `https://www.reddit.com/comments/${id}/`

    encontrados.push({
      redditPostId: id,
      redditFullname: fullname,
      title: titulo,
      permalink,
      createdAt: new Date(criado),
    })
  }

  return encontrados
}
