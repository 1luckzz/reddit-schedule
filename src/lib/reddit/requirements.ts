import type { RedditClient } from './client'
import { RedditError } from './errors'

export type BodyRestrictionPolicy = 'required' | 'notAllowed' | 'none'

export type PostRequirements = {
  titleMinLength: number | null
  titleMaxLength: number
  bodyRestrictionPolicy: BodyRestrictionPolicy
  isFlairRequired: boolean
  domainWhitelist: string[]
  domainBlacklist: string[]
  titleBlacklistedStrings: string[]
  bodyBlacklistedStrings: string[]
}

/** Limite duro do Reddit para títulos. Comunidade nenhuma amplia isso. */
const TITLE_HARD_MAX = 300

/**
 * Valores para campos AUSENTES de uma resposta válida — não substituto para
 * uma resposta que não veio.
 *
 * Não inventam restrição: validar a mais recusaria publicações que o Reddit
 * aceitaria. Aplicá-los a uma falha de leitura teria o efeito oposto e pior:
 * liberaria publicações que o Reddit vai recusar.
 */
export const FIELD_DEFAULTS: PostRequirements = {
  titleMinLength: null,
  titleMaxLength: TITLE_HARD_MAX,
  bodyRestrictionPolicy: 'none',
  isFlairRequired: false,
  domainWhitelist: [],
  domainBlacklist: [],
  titleBlacklistedStrings: [],
  bodyBlacklistedStrings: [],
}

function lista(valor: unknown): string[] {
  return Array.isArray(valor)
    ? valor.filter((v): v is string => typeof v === 'string')
    : []
}

function politica(valor: unknown): BodyRestrictionPolicy {
  return valor === 'required' || valor === 'notAllowed' ? valor : 'none'
}

function indisponivel(detalhe: string): RedditError {
  return new RedditError({
    code: 'REQUIREMENTS_UNAVAILABLE',
    disposition: 'terminal',
    userMessage: `Não foi possível verificar as regras de publicação desta comunidade. ${detalhe}`,
  })
}

/**
 * Lê os requisitos de publicação de uma comunidade.
 *
 * Falha de leitura NUNCA vira requisitos permissivos: se não conseguimos ler
 * as regras, não temos como afirmar que a publicação as respeita. Quem chama
 * decide o que fazer com a indisponibilidade — recusar o agendamento ou pedir
 * confirmação explícita — mas essa decisão precisa ser consciente.
 *
 * Atenção, mesmo no caminho feliz: estes requisitos NÃO cobrem regras de
 * AutoModerator. Uma publicação pode passar por toda a validação local e ainda
 * ser recusada na submissão.
 */
export async function getPostRequirements(
  client: RedditClient,
  subredditName: string,
): Promise<PostRequirements> {
  let raw: Record<string, unknown>

  try {
    const { data } = await client.request<Record<string, unknown>>({
      path: `/api/v1/${subredditName}/post_requirements`,
    })

    if (data !== null && typeof data !== 'object') {
      throw indisponivel('Tente novamente.')
    }

    // A partir daqui a resposta é válida: campos ausentes recebem default.
    raw = data ?? {}
  } catch (e) {
    if (
      e instanceof RedditError &&
      (e.code === 'NO_PERMISSION' || e.code === 'NOT_FOUND')
    ) {
      throw indisponivel('Confirme se a conta ainda a modera e tente novamente.')
    }
    throw e
  }

  const maxBruto = raw.title_text_max_length
  const titleMaxLength =
    typeof maxBruto === 'number' && maxBruto > 0
      ? Math.min(maxBruto, TITLE_HARD_MAX)
      : TITLE_HARD_MAX

  const minBruto = raw.title_text_min_length

  return {
    titleMinLength: typeof minBruto === 'number' && minBruto > 0 ? minBruto : null,
    titleMaxLength,
    bodyRestrictionPolicy: politica(raw.body_restriction_policy),
    isFlairRequired: Boolean(raw.is_flair_required ?? false),
    domainWhitelist: lista(raw.domain_whitelist),
    domainBlacklist: lista(raw.domain_blacklist),
    titleBlacklistedStrings: lista(raw.title_blacklisted_strings),
    bodyBlacklistedStrings: lista(raw.body_blacklisted_strings),
  }
}
