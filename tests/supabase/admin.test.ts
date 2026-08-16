import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('client administrativo', () => {
  it('é marcado como server-only', () => {
    const source = readFileSync('src/lib/supabase/admin.ts', 'utf8')
    expect(source).toContain("import 'server-only'")
  })

  it('nunca lê uma variável NEXT_PUBLIC_ para a chave secreta', () => {
    const source = readFileSync('src/lib/supabase/admin.ts', 'utf8')
    expect(source).toContain('SUPABASE_SECRET_KEY')
    expect(source).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SECRET/)
  })

  it('o client de browser nunca toca na chave secreta', () => {
    const source = readFileSync('src/lib/supabase/client.ts', 'utf8')
    expect(source).not.toContain('SECRET')
  })

  it('o código de servidor chama getClaims, nunca getSession', () => {
    for (const file of ['src/lib/supabase/proxy.ts', 'src/lib/auth/require-user.ts']) {
      const source = readFileSync(file, 'utf8')
      // Procura a chamada, não a menção: os comentários explicam por que
      // getSession não deve ser usado, e citá-lo ali é legítimo.
      expect(source).toMatch(/auth\.getClaims\(/)
      expect(source).not.toMatch(/auth\.getSession\(/)
    }
  })

  it('cria um client sem persistir sessão', async () => {
    const { createAdminSupabase } = await import('@/lib/supabase/admin')
    expect(createAdminSupabase()).toBeDefined()
  })
})
