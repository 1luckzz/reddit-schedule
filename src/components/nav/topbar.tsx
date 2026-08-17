'use client'

import { usePathname } from 'next/navigation'
import { NAV_ITEMS } from './nav-items'

/**
 * Barra superior: localização à esquerda, sessão à direita.
 *
 * O prefixo mais longo vence para que /dashboard/queue resolva para "Fila",
 * e não para "Dashboard".
 */
export function Topbar({ email }: { email: string }) {
  const pathname = usePathname()
  const atual = NAV_ITEMS.filter((i) =>
    i.href === '/dashboard' ? pathname === i.href : pathname.startsWith(i.href),
  ).sort((a, b) => b.href.length - a.href.length)[0]

  return (
    <header className="flex h-13 shrink-0 items-center justify-between border-b border-traco px-6">
      <p className="text-[13px] text-fraco">
        Painel
        {atual && (
          <>
            <span className="mx-1.5 text-traco-forte">/</span>
            <span className="text-medio">{atual.label}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        <span className="hidden text-[13px] text-fraco sm:block" title={email}>
          {email}
        </span>
        <form action="/auth/signout" method="post">
          <button className="rounded-lg border border-traco px-2.5 py-1 text-[13px] text-medio transition-colors duration-150 hover:border-traco-forte hover:text-claro active:scale-[0.98]">
            Sair
          </button>
        </form>
      </div>
    </header>
  )
}
