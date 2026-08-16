import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/lib/auth/ownership.ts', 'utf8')

describe('ownership', () => {
  it('getAccountSecrets e getNetworkConfig não aceitam string', () => {
    expect(source).toMatch(/getAccountSecrets\(\s*account: VerifiedAccount/)
    expect(source).toMatch(/getNetworkConfig\(\s*account: VerifiedAccount/)
    expect(source).not.toMatch(/getAccountSecrets\(\s*\w+: string/)
    expect(source).not.toMatch(/getNetworkConfig\(\s*\w+: string/)
  })

  it('assertAccountAccess consulta com o client do usuário, não o admin', () => {
    const fn = source.slice(
      source.indexOf('export async function assertAccountAccess'),
      source.indexOf('export async function getAccountSecrets'),
    )
    expect(fn).toContain('createServerSupabase')
    expect(fn).not.toContain('createAdminSupabase')
  })

  it('compara owner_id em runtime, não só confia na RLS', () => {
    expect(source).toMatch(/owner_id\s*!==\s*user\.id/)
  })

  it('é server-only', () => {
    expect(source).toContain("import 'server-only'")
  })
})
