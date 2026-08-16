import type { PostRequirements } from '@/lib/reddit/requirements'

export type PostIntent = {
  title: string
  url?: string
  body?: string
  flairId?: string
  nsfw: boolean
  spoiler: boolean
  /**
   * O usuário confirmou que, havendo link e texto, o texto vira comentário
   * automático. Sem confirmação, a combinação é recusada em vez de decidida
   * pelo sistema.
   */
  allowCommentFallback: boolean
}

export type SubredditInfo = {
  name: string
  submissionType: 'any' | 'link' | 'self'
  linkFlairEnabled: boolean
}

export type BuiltPayload = {
  postKind: 'link' | 'self'
  title: string
  url: string | null
  body: string | null
  flairId: string | null
  nsfw: boolean
  spoiler: boolean
  /** Texto que vira comentário automático, quando houver. */
  commentBody: string | null
}

export class PayloadError extends Error {
  readonly field: string
  readonly userMessage: string

  constructor(field: string, userMessage: string) {
    super(`${field}: ${userMessage}`)
    this.name = 'PayloadError'
    this.field = field
    this.userMessage = userMessage
  }
}

function normalizarUrl(bruta: string): URL {
  let url: URL
  try {
    url = new URL(bruta)
  } catch {
    throw new PayloadError('url', 'O link informado não é uma URL válida.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PayloadError('url', 'O link precisa começar com http ou https.')
  }
  return url
}

/** Casa domínio e subdomínios: www.youtube.com casa com youtube.com. */
function dominioCasa(host: string, dominio: string): boolean {
  const h = host.toLowerCase()
  const d = dominio.toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

function contemTermo(texto: string, termos: string[]): string | null {
  const alvo = texto.toLowerCase()
  return termos.find((t) => t && alvo.includes(t.toLowerCase())) ?? null
}

/**
 * Traduz a intenção do usuário em um payload que a API do Reddit aceita.
 *
 * Lança PayloadError na primeira violação, com o campo responsável — o
 * formulário usa isso para destacar o campo certo.
 */
export function buildPayload(
  intent: PostIntent,
  requirements: PostRequirements,
  subreddit: SubredditInfo,
): BuiltPayload {
  const title = intent.title.trim()
  const url = intent.url?.trim() || null
  const body = intent.body?.trim() || null

  // --- título ---
  if (title.length === 0) {
    throw new PayloadError('title', 'Informe o título da publicação.')
  }
  if (title.length > requirements.titleMaxLength) {
    throw new PayloadError(
      'title',
      `O título passa do limite desta comunidade (${requirements.titleMaxLength} caracteres).`,
    )
  }
  if (
    requirements.titleMinLength !== null &&
    title.length < requirements.titleMinLength
  ) {
    throw new PayloadError(
      'title',
      `Esta comunidade exige título com pelo menos ${requirements.titleMinLength} caracteres.`,
    )
  }
  const termoTitulo = contemTermo(title, requirements.titleBlacklistedStrings)
  if (termoTitulo) {
    throw new PayloadError(
      'title',
      `Esta comunidade não permite o termo "${termoTitulo}" no título.`,
    )
  }

  // --- decide o tipo ---
  if (!url && !body) {
    throw new PayloadError('url', 'Informe um link ou um texto para publicar.')
  }

  const postKind: 'link' | 'self' = url ? 'link' : 'self'
  // A API não aceita link e corpo juntos; o corpo vira comentário.
  const commentBody = url && body ? body : null

  if (commentBody && !intent.allowCommentFallback) {
    throw new PayloadError(
      'body',
      'A API do Reddit não permite link e texto na mesma publicação. ' +
        'Ative o comentário automático para enviar o texto logo após a publicação, ' +
        'ou remova um dos dois.',
    )
  }

  // --- restrições da comunidade ---
  if (postKind === 'link' && subreddit.submissionType === 'self') {
    throw new PayloadError(
      'url',
      `A comunidade r/${subreddit.name} aceita apenas publicações de texto.`,
    )
  }
  if (postKind === 'self' && subreddit.submissionType === 'link') {
    throw new PayloadError(
      'body',
      `A comunidade r/${subreddit.name} aceita apenas publicações com link.`,
    )
  }

  if (postKind === 'link' && requirements.bodyRestrictionPolicy === 'required') {
    throw new PayloadError(
      'url',
      'Esta comunidade exige texto no corpo da publicação, o que é incompatível com um link.',
    )
  }
  if (postKind === 'self' && requirements.bodyRestrictionPolicy === 'notAllowed') {
    throw new PayloadError(
      'body',
      'Esta comunidade não permite texto no corpo da publicação.',
    )
  }

  // --- corpo (do post ou do comentário) ---
  if (body) {
    const termoCorpo = contemTermo(body, requirements.bodyBlacklistedStrings)
    if (termoCorpo) {
      throw new PayloadError(
        'body',
        `Esta comunidade não permite o termo "${termoCorpo}" no texto.`,
      )
    }
  }

  // --- link ---
  if (url) {
    const parsed = normalizarUrl(url)
    const host = parsed.hostname

    if (
      requirements.domainWhitelist.length > 0 &&
      !requirements.domainWhitelist.some((d) => dominioCasa(host, d))
    ) {
      throw new PayloadError(
        'url',
        `Esta comunidade só aceita links de: ${requirements.domainWhitelist.join(', ')}.`,
      )
    }
    if (requirements.domainBlacklist.some((d) => dominioCasa(host, d))) {
      throw new PayloadError(
        'url',
        'Esta comunidade não aceita links deste domínio.',
      )
    }
  }

  // --- flair ---
  const flairId = intent.flairId?.trim() || null
  if (requirements.isFlairRequired && !flairId) {
    throw new PayloadError('flairId', 'Esta comunidade exige um flair.')
  }

  return {
    postKind,
    title,
    url: postKind === 'link' ? url : null,
    body: postKind === 'self' ? body : null,
    flairId,
    nsfw: intent.nsfw,
    spoiler: intent.spoiler,
    commentBody,
  }
}
