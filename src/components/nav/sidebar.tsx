'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_ITEMS } from './nav-items'

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname()

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-risco bg-console">
      <div className="flex items-center gap-2 border-b border-risco px-4 py-5">
        {/* A lâmpada de energia do console. */}
        <span aria-hidden className="size-2 rounded-full bg-ambar" />
        <span className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-fosforo">
          Reddit Scheduler
        </span>
      </div>

      <nav className="flex-1 space-y-px px-2 py-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            href === '/dashboard' ? pathname === href : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 border-l-2 px-2.5 py-2 font-display text-[13px] font-medium uppercase tracking-[0.1em] transition-colors ${
                active
                  ? 'border-ambar bg-console-2 text-fosforo'
                  : 'border-transparent text-fosforo-dim hover:bg-console-2/60 hover:text-fosforo'
              }`}
            >
              <Icon
                className={`size-4 ${active ? 'text-ambar' : 'text-fosforo-dim/70'}`}
                aria-hidden
              />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-risco p-3">
        <p
          className="truncate px-1 font-mono text-[11px] text-fosforo-dim"
          title={email}
        >
          {email}
        </p>
        <form action="/auth/signout" method="post">
          <button className="mt-2 w-full rounded-sm border border-risco px-2 py-1.5 font-display text-[11px] font-medium uppercase tracking-[0.12em] text-fosforo-dim transition-colors hover:bg-console-2 hover:text-fosforo">
            Sair
          </button>
        </form>
      </div>
    </aside>
  )
}
