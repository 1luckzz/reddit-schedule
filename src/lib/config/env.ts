import { z } from 'zod'

export class EnvError extends Error {
  constructor(issues: string[]) {
    // Apenas nomes de variáveis e mensagens de validação. Nunca os valores:
    // esta mensagem acaba em log e em stack trace.
    super(`Variáveis de ambiente inválidas:\n${issues.join('\n')}`)
    this.name = 'EnvError'
  }
}

const base64Key32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, 'base64').length === 32
  } catch {
    return false
  }
}, 'ENCRYPTION_KEY deve ser exatamente 32 bytes codificados em base64')

// Zod 4: os validadores de formato são funções de topo (z.url(), z.email()).
// As formas antigas (z.string().url()) ainda funcionam, mas estão depreciadas.
const coreSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  ENCRYPTION_KEY: base64Key32,
  APP_URL: z.url(),
})

const redditSchema = z.object({
  REDDIT_CLIENT_ID: z.string().min(1),
  REDDIT_CLIENT_SECRET: z.string().min(1),
  REDDIT_REDIRECT_URI: z.url(),
  REDDIT_USER_AGENT: z.string().min(1),
})

export type CoreEnv = z.infer<typeof coreSchema>
export type RedditEnv = z.infer<typeof redditSchema>

function parse<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `- ${i.path.join('.')}: ${i.message}`,
    )
    throw new EnvError(issues)
  }
  return result.data
}

/**
 * Ambiente necessário para o painel subir. Não inclui as credenciais do
 * Reddit de propósito: elas só passam a ser exigidas quando a integração
 * entra em uso, e exigi-las aqui impediria a aplicação de iniciar antes disso.
 */
export function getCoreEnv(): CoreEnv {
  return parse(coreSchema, process.env)
}

/** Exigido apenas nos caminhos que falam com a API do Reddit. */
export function getRedditEnv(): RedditEnv {
  return parse(redditSchema, process.env)
}
