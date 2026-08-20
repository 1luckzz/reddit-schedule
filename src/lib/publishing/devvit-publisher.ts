import 'server-only'

/**
 * Ponte site -> Devvit.
 *
 * O Devvit executa a publicação dentro da infraestrutura do Reddit, como
 * conta do app (runAs 'APP'): nem o OAuth por conta nem a proxy do worker
 * participam deste caminho. A implementação real usará um External Endpoint
 * autenticado por Managed Token — recurso hoje de acesso limitado, ainda não
 * concedido a este app. Enquanto isso a factory devolve a implementação
 * indisponível, e o registro fica aguardando com devvit_sync_status =
 * 'pending' (nunca há fallback silencioso para o worker).
 */

export type DevvitScheduleRequest = {
  /** Id da linha em scheduled_posts: vira o id do registro no Devvit. */
  postId: string
  /** Nome do subreddit, minúsculo, já validado contra devvit_installations. */
  subredditName: string
  /** Identificadores oficiais da instalação, de devvit_installations. */
  appSlug: string
  installLocationId: string | null
  title: string
  kind: 'link' | 'self'
  url?: string
  body?: string
  commentBody?: string
  flairId?: string
  nsfw?: boolean
  spoiler?: boolean
  /** Instante UTC em ISO. */
  runAtUtc: string
}

export type DevvitScheduleResult =
  | { ok: true; devvitJobId: string }
  | {
      ok: false
      /**
       * unavailable: a ponte ainda não existe (sem token/acesso) — o registro
       *   fica pending, aguardando sincronização.
       * rejected: o Devvit recusou o payload — erro de dados, não de
       *   transporte.
       * network: falha de comunicação — reenviar é seguro (o endpoint é
       *   idempotente pelo postId).
       */
      code: 'unavailable' | 'rejected' | 'network'
      message: string
    }

export type DevvitPublisher = {
  schedule(req: DevvitScheduleRequest): Promise<DevvitScheduleResult>
  cancel(devvitJobId: string): Promise<{ ok: boolean }>
}
