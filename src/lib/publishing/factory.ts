import 'server-only'
import type { DevvitPublisher } from './devvit-publisher'
import { UnavailableDevvitPublisher } from './unavailable-devvit-publisher'

/**
 * Escolhe a implementação da ponte Devvit pelo ambiente.
 *
 * O Managed Token vive EXCLUSIVAMENTE em DEVVIT_MANAGED_TOKEN, uma variável
 * server-side: nunca em NEXT_PUBLIC_*, nunca em log, nunca no Supabase. A
 * URL do endpoint deriva dos identificadores oficiais da instalação
 * (app_slug + install_location_id), não de configuração hardcoded.
 *
 * Enquanto o app não tem acesso a External Endpoints, a variável não existe
 * e a factory devolve a implementação indisponível — o registro fica em
 * devvit_sync_status = 'pending', sem fallback silencioso para o worker.
 * Quando o acesso for concedido, a implementação real entra aqui, atrás da
 * mesma interface, sem mudar nenhum chamador.
 */
export function getDevvitPublisher(): DevvitPublisher {
  // Intencional: mesmo com a variável presente, ainda não existe transporte
  // real — não simulamos a ponte antes do acesso oficial ao recurso.
  return new UnavailableDevvitPublisher()
}
