import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from '@/components/nav/nav-items'

describe('NAV_ITEMS', () => {
  it('cobre as dez seções de navegação', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Dashboard',
      'Nova publicação',
      'Calendário',
      'Fila',
      'Revisão',
      'Histórico',
      'Contas Reddit',
      'Comunidades',
      'Logs',
      'Configurações',
    ])
  })

  it('todas as rotas ficam sob /dashboard', () => {
    expect(NAV_ITEMS.every((i) => i.href.startsWith('/dashboard'))).toBe(true)
  })

  it('não repete hrefs', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('todo item tem um ícone', () => {
    expect(NAV_ITEMS.every((i) => typeof i.icon !== 'undefined')).toBe(true)
  })
})
