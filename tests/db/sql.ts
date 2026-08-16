import pg from 'pg'

/**
 * Conexão privilegiada direta ao Postgres, só para testes que precisam de DDL
 * (conceder e revogar grants, inspecionar catálogo). O supabase-js não executa
 * DDL, e alguns cenários de segurança só podem ser montados assim.
 */
const CONNECTION =
  process.env.SUPABASE_DB_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

export async function withSql<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: CONNECTION })
  await db.connect()
  try {
    return await fn(db)
  } finally {
    await db.end()
  }
}
