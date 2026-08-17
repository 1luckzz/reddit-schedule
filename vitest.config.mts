import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolve = {
  // O Vite resolve os paths do tsconfig nativamente; o plugin
  // vite-tsconfig-paths seria redundante.
  tsconfigPaths: true,
  alias: {
    'server-only': fileURLToPath(
      new URL('./tests/stubs/server-only.ts', import.meta.url),
    ),
  },
}

export default defineConfig({
  resolve,
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/db/**'],
          globals: false,
          setupFiles: ['tests/setup-env.ts'],
        },
      },
      {
        resolve,
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          globals: false,
          setupFiles: ['tests/setup-env.ts'],
          // ---------------------------------------------------------------
          // Um arquivo por vez, de propósito.
          // ---------------------------------------------------------------
          // Todos estes testes compartilham UM banco. A fila do worker é
          // global por natureza — `claim_due_posts` e `reap_stale_jobs`
          // varrem todas as linhas, que é como o worker precisa funcionar — e
          // alguns arquivos executam DDL (grants por coluna) que tranca a
          // tabela inteira.
          //
          // Já tropeçamos nisso três vezes: no `client_id` do orçamento, nos
          // jobs reivindicados entre arquivos e nos grants. Cada vez o
          // conserto pontual escondeu a causa comum. Serializar os arquivos
          // trata a classe do problema; o custo é alguns segundos.
          fileParallelism: false,
        },
      },
    ],
  },
})
