import type { RedditClient } from './client'

/**
 * Teto de páginas da listagem.
 *
 * A cada página vêm até 100 comunidades, então 20 páginas cobrem 2000 — bem
 * acima do que qualquer conta modera na prática, e acima do limite de ~1000
 * itens que as listagens do Reddit costumam impor. O teto existe porque um
 * cursor repetido viraria laço infinito.
 */
export const MAX_PAGES = 20

export type ModeratedSubreddit = {
  fullname: string
  name: string
  displayName: string
  url: string
  over18: boolean
  submissionType: 'any' | 'link' | 'self'
  linkFlairEnabled: boolean
  canAssignLinkFlair: boolean
  subredditType: string | null
}

type Listing = {
  data?: {
    after?: string | null
    children?: { kind?: string; data?: Record<string, unknown> }[]
  }
}

function normalizar(raw: Record<string, unknown>): ModeratedSubreddit | null {
  const fullname = raw.name
  const name = raw.display_name
  if (typeof fullname !== 'string' || typeof name !== 'string') return null

  const tipo = raw.submission_type
  const submissionType =
    tipo === 'link' || tipo === 'self' || tipo === 'any' ? tipo : 'any'

  return {
    fullname,
    name,
    displayName: typeof raw.title === 'string' ? raw.title : name,
    url: typeof raw.url === 'string' ? raw.url : `/r/${name}/`,
    // A API alterna entre over18 e over_18 conforme o endpoint.
    over18: Boolean(raw.over18 ?? raw.over_18 ?? false),
    submissionType,
    linkFlairEnabled: Boolean(raw.link_flair_enabled ?? false),
    canAssignLinkFlair: Boolean(raw.can_assign_link_flair ?? false),
    subredditType:
      typeof raw.subreddit_type === 'string' ? raw.subreddit_type : null,
  }
}

export async function listModeratedSubreddits(
  client: RedditClient,
): Promise<ModeratedSubreddit[]> {
  const encontradas: ModeratedSubreddit[] = []
  const vistas = new Set<string>()
  let after: string | null = null

  for (let pagina = 0; pagina < MAX_PAGES; pagina++) {
    const query: Record<string, string> = { limit: '100' }
    if (after) query.after = after

    const { data }: { data: Listing } = await client.request<Listing>({
      path: '/subreddits/mine/moderator',
      query,
    })

    for (const child of data?.data?.children ?? []) {
      if (child.kind !== 't5' || !child.data) continue
      const sub = normalizar(child.data)
      // Cursor repetido pela API traria as mesmas comunidades de novo.
      if (sub && !vistas.has(sub.fullname)) {
        vistas.add(sub.fullname)
        encontradas.push(sub)
      }
    }

    after = data?.data?.after ?? null
    if (!after) break
  }

  return encontradas
}
