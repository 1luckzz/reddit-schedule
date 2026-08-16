import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * Mapeia os arquivos de página para as URLs que o Next realmente gera.
 * Segmentos entre parênteses são route groups e NÃO entram na URL — foi
 * exatamente esse detalhe que fez `(dashboard)/accounts` virar `/accounts`
 * em vez de `/dashboard/accounts`.
 */
function rotasExistentes(dir = join('src', 'app'), prefixo = ''): string[] {
  const rotas: string[] = []

  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.isDirectory()) {
      const grupo = entrada.name.startsWith('(') && entrada.name.endsWith(')')
      const segmento = grupo ? prefixo : `${prefixo}/${entrada.name}`
      rotas.push(...rotasExistentes(join(dir, entrada.name), segmento))
    } else if (entrada.name === 'page.tsx' || entrada.name === 'route.ts') {
      rotas.push(prefixo === '' ? '/' : prefixo.split(sep).join('/'))
    }
  }

  return rotas
}

const rotas = rotasExistentes()

describe('rotas geradas', () => {
  it('a página de contas responde em /dashboard/accounts', () => {
    expect(rotas).toContain('/dashboard/accounts')
    // O route group não pode ter vazado para a URL.
    expect(rotas).not.toContain('/accounts')
    expect(rotas.some((r) => r.includes('('))).toBe(false)
  })

  it('as rotas de OAuth existem nos caminhos que o Reddit vai chamar', () => {
    expect(rotas).toContain('/api/reddit/authorize')
    expect(rotas).toContain('/api/reddit/callback')
  })

  it('o redirect do callback aponta para uma rota que existe', async () => {
    const { readFileSync } = await import('node:fs')
    const callback = readFileSync(
      'src/app/api/reddit/callback/route.ts',
      'utf8',
    )
    const destino = callback.match(/new URL\('([^']+)'/)?.[1]
    expect(destino).toBeDefined()
    expect(rotas).toContain(destino)
  })

  it('todo item de navegação já implementado aponta para rota existente', async () => {
    const { NAV_ITEMS } = await import('@/components/nav/nav-items')
    // As demais páginas chegam nos Planos 3 a 5; estas já devem existir.
    const implementadas = ['/dashboard', '/dashboard/accounts']

    for (const href of implementadas) {
      expect(NAV_ITEMS.map((i) => i.href)).toContain(href)
      expect(rotas).toContain(href)
    }
  })
})
