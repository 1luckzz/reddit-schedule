import { existsSync } from 'node:fs'

// Node 24 carrega arquivos .env nativamente. Os testes de integração falam
// com o Supabase local, cujas credenciais vivem em .env.local (gitignored).
if (existsSync('.env.local')) {
  process.loadEnvFile('.env.local')
}
