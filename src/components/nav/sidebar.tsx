'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_ITEMS } from './nav-items'

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname()

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="px-4 py-5">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
          Reddit Scheduler
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 px-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            href === '/dashboard' ? pathname === href : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                active
                  ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50'
                  : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800/50'
              }`}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        <p className="truncate px-1 text-xs text-neutral-500" title={email}>
          {email}
        </p>
        <form action="/auth/signout" method="post">
          <button className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
            Sair
          </button>
        </form>
      </div>
    </aside>
  )
}
