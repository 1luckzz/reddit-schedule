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
          // Todos estes testes compartilham UM banco, e a fila do worker é
          // global por natureza: `claim_due_posts` e `reap_stale_jobs` varrem
          // todas as linhas, que é exatamente como o worker precisa funcionar.
          // Dois arquivos em paralelo reivindicam os jobs um do outro.
          //
          // Já custou dois consertos pontuais — o `client_id` do orçamento e
          // os jobs entre arquivos — antes de ficar claro que era uma classe
          // de problema, e não casos isolados. Serializar custa alguns
          // segundos e encerra o assunto.
          fileParallelism: false,
        },
      },
    ],
  },
})
