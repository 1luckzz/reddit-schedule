import 'server-only'
import type {
  DevvitPublisher,
  DevvitScheduleResult,
} from './devvit-publisher'

/**
 * A implementação enquanto o app não tem acesso a External Endpoints.
 *
 * Não simula sucesso e não toca em rede: devolve 'unavailable' e deixa o
 * chamador manter o registro em devvit_sync_status = 'pending'. Quando o
 * Managed Token existir, a factory passa a devolver a implementação real e
 * os registros pendentes são sincronizados.
 */
export class UnavailableDevvitPublisher implements DevvitPublisher {
  async schedule(): Promise<DevvitScheduleResult> {
    return {
      ok: false,
      code: 'unavailable',
      message:
        'A ponte com o Devvit ainda não está disponível: aguardando acesso a External Endpoints.',
    }
  }

  async cancel(): Promise<{ ok: boolean }> {
    return { ok: false }
  }
}
