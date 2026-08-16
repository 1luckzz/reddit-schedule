import { z } from 'zod'
import { SUPPORTED_PROXY_PROTOCOLS } from '@/lib/reddit/proxy-support'

export const networkConfigSchema = z.object({
  accountId: z.uuid(),
  // Deriva dos protocolos confirmados por teste de travessia real: remover um
  // de SUPPORTED_PROXY_PROTOCOLS o remove da validação e da UI de uma vez.
  protocol: z.enum(SUPPORTED_PROXY_PROTOCOLS),
  host: z.string().trim().min(1, 'Informe o host.'),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().default(''),
  password: z.string().default(''),
})

export type NetworkConfigForm = z.infer<typeof networkConfigSchema>

export type ActionState = { error: string | null; ok: boolean }
