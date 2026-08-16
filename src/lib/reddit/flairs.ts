import type { RedditClient } from './client'
import { RedditError } from './errors'

export type LinkFlair = {
  id: string
  text: string
  textEditable: boolean
  modOnly: boolean
  backgroundColor: string | null
  textColor: string | null
}

function normalizar(raw: unknown): LinkFlair | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  if (typeof f.id !== 'string' || f.id === '') return null

  return {
    id: f.id,
    text: typeof f.text === 'string' ? f.text : '',
    textEditable: Boolean(f.text_editable ?? false),
    modOnly: Boolean(f.mod_only ?? false),
    backgroundColor:
      typeof f.background_color === 'string' ? f.background_color : null,
    textColor: typeof f.text_color === 'string' ? f.text_color : null,
  }
}

function indisponivel(): RedditError {
  return new RedditError({
    code: 'FLAIRS_UNAVAILABLE',
    disposition: 'terminal',
    userMessage:
      'Não foi possível consultar os flairs desta comunidade. Verifique se a conta ainda a modera e tente novamente.',
  })
}

/**
 * Lê os flairs de publicação de uma comunidade.
 *
 * Não persiste nada: flairs mudam sem aviso e um cache desatualizado faria o
 * formulário oferecer opções que o Reddit recusaria na submissão.
 *
 * Lista vazia só é devolvida quando o Reddit respondeu com sucesso e não havia
 * flair cadastrado. Qualquer falha de leitura vira erro — devolver [] faria o
 * formulário afirmar "esta comunidade não usa flair" quando a verdade é "não
 * foi possível verificar", e o agendamento seria liberado com base numa
 * afirmação falsa.
 */
export async function listLinkFlairs(
  client: RedditClient,
  subredditName: string,
): Promise<LinkFlair[]> {
  let data: unknown

  try {
    ;({ data } = await client.request<unknown>({
      path: `/r/${subredditName}/api/link_flair_v2`,
    }))
  } catch (e) {
    // Sem permissão ou comunidade inexistente: não sabemos quais flairs
    // existem. Erros transitórios sobem com a disposição original.
    if (
      e instanceof RedditError &&
      (e.code === 'NO_PERMISSION' || e.code === 'NOT_FOUND')
    ) {
      throw indisponivel()
    }
    throw e
  }

  if (!Array.isArray(data)) throw indisponivel()

  return data.map(normalizar).filter((f): f is LinkFlair => f !== null)
}
