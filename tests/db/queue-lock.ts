import pg from 'pg'

const CONNECTION =
  process.env.SUPABASE_DB_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

/** Arbitrária; só precisa ser a mesma em todos os arquivos que a usam. */
const CHAVE = 20260817

let db: pg.Client | null = null

/**
 * Serializa os arquivos de teste que exercitam a fila global do worker.
 *
 * `claim_due_posts` e `reap_stale_jobs` operam sobre TODA a fila, não sobre as
 * linhas de um usuário — é assim que o worker precisa funcionar. A consequência
 * é que dois arquivos rodando em paralelo reivindicam os jobs um do outro, e o
 * Vitest paraleliza arquivos por padrão.
 *
 * Filtrar as asserções por id resolveria parte do problema, mas não os testes
 * de lote e de ordenação, em que um job estranho ocupa uma vaga. O lock
 * consultivo do Postgres resolve na raiz e só custa tempo aos arquivos que
 * realmente competem.
 *
 * Cada arquivo chama isto no `beforeAll` e libera no `afterAll`, DEPOIS de
 * limpar suas linhas — senão o próximo arquivo herdaria jobs vencidos.
 */
export async function acquireQueueLock(): Promise<void> {
  db = new pg.Client({ connectionString: CONNECTION })
  await db.connect()
  await db.query('select pg_advisory_lock($1)', [CHAVE])
}

export async function releaseQueueLock(): Promise<void> {
  if (!db) return
  await db.query('select pg_advisory_unlock($1)', [CHAVE])
  await db.end()
  db = null
}
