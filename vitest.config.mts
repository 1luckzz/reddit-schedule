import { defineConfig } from 'vitest/config'

export default defineConfig({
  // O Vite resolve os paths do tsconfig nativamente; o plugin
  // vite-tsconfig-paths seria redundante.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
})
