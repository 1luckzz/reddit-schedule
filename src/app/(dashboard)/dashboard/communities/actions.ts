'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { assertAccountAccess, ForbiddenError } from '@/lib/auth/ownership'
import { syncCommunitiesFor } from '@/lib/reddit/sync-communities'
import { RedditError } from '@/lib/reddit/errors'

const schema = z.object({ accountId: z.uuid() })

export type SyncState = {
  error: string | null
  message: string | null
}

export async function syncCommunities(
  _prev: SyncState,
  formData: FormData,
): Promise<SyncState> {
  const parsed = schema.safeParse({ accountId: formData.get('accountId') })
  if (!parsed.success) {
    return { error: 'Conta inválida.', message: null }
  }

  try {
    const account = await assertAccountAccess(parsed.data.accountId)
    const r = await syncCommunitiesFor(account)

    revalidatePath('/dashboard/communities')
    return {
      error: null,
      message:
        `${r.total} comunidade(s) sincronizada(s): ` +
        `${r.criadas} nova(s), ${r.atualizadas} atualizada(s)` +
        (r.removidas > 0 ? `, ${r.removidas} sem acesso` : '') +
        '.',
    }
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return { error: 'Conta não encontrada.', message: null }
    }
    if (e instanceof RedditError) {
      // Inclui BUDGET_EXHAUSTED, BUDGET_BOOTSTRAP, BUDGET_UNAVAILABLE,
      // NO_PERMISSION e conta desconectada — todos já trazem mensagem pronta.
      return { error: e.userMessage, message: null }
    }
    return {
      error: 'Não foi possível sincronizar as comunidades agora.',
      message: null,
    }
  }
}
