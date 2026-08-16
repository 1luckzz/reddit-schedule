export type CommunityRow = {
  id: string
  name: string
  display_name: string
  url: string
  over_18: boolean
  submission_type: string | null
  link_flair_enabled: boolean
  last_synced_at: string | null
}

const TIPO_LABEL: Record<string, string> = {
  any: 'link e texto',
  link: 'somente link',
  self: 'somente texto',
}

const chip =
  'rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'

export function CommunityList({ communities }: { communities: CommunityRow[] }) {
  if (communities.length === 0) {
    return (
      <p className="mt-3 text-sm text-neutral-500">
        Nenhuma comunidade sincronizada para esta conta ainda.
      </p>
    )
  }

  return (
    <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
      {communities.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
              r/{c.name}
            </p>
            <p className="truncate text-xs text-neutral-500">{c.display_name}</p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {c.submission_type && (
              <span className={chip}>
                {TIPO_LABEL[c.submission_type] ?? c.submission_type}
              </span>
            )}
            {c.link_flair_enabled && <span className={chip}>flair</span>}
            {c.over_18 && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                +18
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
