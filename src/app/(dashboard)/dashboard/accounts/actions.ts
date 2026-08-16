'use server'

import { revalidatePath } from 'next/cache'
import { assertAccountAccess, ForbiddenError } from '@/lib/auth/ownership'
import { createServerSupabase } from '@/lib/supabase/server'
import {
  clearNetworkConfigFor,
  clearProxyCredentialsFor,
  saveNetworkConfigFor,
} from '@/lib/reddit/network-config'
import { networkConfigSchema, type ActionState } from './schema'

export async function saveNetworkConfig(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = networkConfigSchema.safeParse({
    accountId: formData.get('accountId'),
    protocol: formData.get('protocol'),
    host: formData.get('host'),
    port: formData.get('port'),
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, ok: false }
  }

  try {
    // Posse verificada antes de qualquer escrita em tabela de segredo.
    const account = await assertAccountAccess(parsed.data.accountId)
    await saveNetworkConfigFor(account, {
      protocol: parsed.data.protocol,
      host: parsed.data.host,
      port: parsed.data.port,
      username: parsed.data.username,
      password: parsed.data.password,
    })
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return { error: 'Conta não encontrada.', ok: false }
    }
    return { error: 'Não foi possível salvar a configuração de rede.', ok: false }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}

export async function clearProxyCredentials(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const accountId = String(formData.get('accountId') ?? '')

  try {
    const account = await assertAccountAccess(accountId)
    await clearProxyCredentialsFor(account)
  } catch {
    return {
      error: 'Não foi possível remover as credenciais do proxy.',
      ok: false,
    }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}

export async function disableNetworkConfig(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const accountId = String(formData.get('accountId') ?? '')

  try {
    const account = await assertAccountAccess(accountId)
    await clearNetworkConfigFor(account)
  } catch {
    return {
      error: 'Não foi possível desativar a configuração de rede.',
      ok: false,
    }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}

export async function disconnectAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const accountId = String(formData.get('accountId') ?? '')

  try {
    const account = await assertAccountAccess(accountId)
    // A remoção usa o client do usuário: a RLS é a última barreira.
    const supabase = await createServerSupabase()
    const { error } = await supabase
      .from('reddit_accounts')
      .delete()
      .eq('id', account.id)
    if (error) throw error
  } catch {
    return { error: 'Não foi possível desconectar a conta.', ok: false }
  }

  revalidatePath('/dashboard/accounts')
  return { error: null, ok: true }
}
