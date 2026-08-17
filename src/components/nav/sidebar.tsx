'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_ITEMS } from './nav-items'

/**
 * Trilho de navegação: mesmo fundo da página, separado só pela borda.
 * A sessão (e-mail e Sair) mora na topbar.
 */
export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-traco bg-fundo">
      <div className="px-5 pb-4 pt-5">
        <span className="text-sm font-semibold tracking-[-0.01em] text-forte">
          Reddit Scheduler
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 px-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            href === '/dashboard' ? pathname === href : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors duration-150 ${
                active
                  ? 'bg-white/[0.07] font-medium text-forte'
                  : 'text-medio hover:bg-white/5 hover:text-claro'
              }`}
            >
              <Icon
                className={`size-4 ${active ? 'text-claro' : 'text-fraco'}`}
                aria-hidden
              />
              {label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
