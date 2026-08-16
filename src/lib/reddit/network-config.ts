import 'server-only'
import { createAdminSupabase } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/crypto/aes-gcm'
import type { VerifiedAccount } from '@/lib/auth/ownership'
import type { ProxyProtocol } from './proxy-support'

// O tipo vive aqui, não em app/: lib/ nunca importa de app/, ou a camada de
// domínio passa a depender da camada de apresentação.
export type NetworkConfigInput = {
  protocol: ProxyProtocol
  host: string
  port: number
  username: string
  password: string
}

export async function saveNetworkConfigFor(
  account: VerifiedAccount,
  input: NetworkConfigInput,
): Promise<void> {
  const admin = createAdminSupabase()

  // Senha em branco significa "mantenha a atual", porque o formulário nunca
  // recebe a senha de volta do servidor e portanto não teria como reenviá-la.
  // Para apagar de fato, existe clearProxyCredentialsFor.
  let passwordEnc: string | null = null
  if (input.password) {
    passwordEnc = encryptSecret(
      input.password,
      `reddit_account_network_configs:proxy_password:${account.id}`,
    )
  } else {
    const { data } = await admin
      .from('reddit_account_network_configs')
      .select('proxy_password_enc')
      .eq('reddit_account_id', account.id)
      .maybeSingle()
    passwordEnc = data?.proxy_password_enc ?? null
  }

  await admin.from('reddit_account_network_configs').upsert(
    {
      reddit_account_id: account.id,
      owner_id: account.owner_id,
      proxy_enabled: true,
      proxy_protocol: input.protocol,
      proxy_host: input.host,
      proxy_port: input.port,
      proxy_username: input.username || null,
      proxy_password_enc: passwordEnc,
    },
    { onConflict: 'reddit_account_id' },
  )
}

/**
 * Remove usuário e senha do proxy, mantendo host, porta e protocolo.
 *
 * Existe porque "senha em branco preserva a atual" torna impossível apagar
 * uma credencial pelo formulário: sem esta ação, uma senha gravada por engano
 * ficaria no banco para sempre.
 */
export async function clearProxyCredentialsFor(
  account: VerifiedAccount,
): Promise<void> {
  const admin = createAdminSupabase()
  await admin
    .from('reddit_account_network_configs')
    .update({ proxy_username: null, proxy_password_enc: null })
    .eq('reddit_account_id', account.id)
}

/** Remove a configuração de rede inteira: a conta volta à conexão direta. */
export async function clearNetworkConfigFor(
  account: VerifiedAccount,
): Promise<void> {
  const admin = createAdminSupabase()
  await admin
    .from('reddit_account_network_configs')
    .delete()
    .eq('reddit_account_id', account.id)
}
