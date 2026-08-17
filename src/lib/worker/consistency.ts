export type JobOwnership = {
  postOwnerId: string
  accountOwnerId: string
  subredditOwnerId: string
  postAccountId: string
  subredditAccountId: string
}

export class InconsistentOwnershipError extends Error {
  constructor() {
    // Sem identificadores na mensagem: ela vai para log.
    super(
      'Job com vínculos inconsistentes entre publicação, conta e comunidade.',
    )
    this.name = 'InconsistentOwnershipError'
  }
}

/**
 * Confere que publicação, conta e comunidade pertencem ao mesmo dono, e que a
 * comunidade é da conta escolhida.
 *
 * As FKs compostas já tornam isso impossível no banco. Esta função é defesa
 * em profundidade contra uma migration futura que as afrouxe: antes de
 * publicar em nome de alguém, o worker confirma de novo.
 *
 * No worker não há sessão para verificar posse — é esta coerência, garantida
 * no banco e reconferida aqui, que faz o papel de `assertAccountAccess`.
 */
export function assertJobConsistency(job: JobOwnership): void {
  const mesmoDono =
    job.postOwnerId === job.accountOwnerId &&
    job.postOwnerId === job.subredditOwnerId
  const comunidadeDaConta = job.postAccountId === job.subredditAccountId

  if (!mesmoDono || !comunidadeDaConta) {
    throw new InconsistentOwnershipError()
  }
}
