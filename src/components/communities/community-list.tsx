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
  'rounded-sm border border-risco bg-console-2 px-1.5 py-0.5 font-display uppercase tracking-[0.06em] text-fosforo-dim'

export function CommunityList({ communities }: { communities: CommunityRow[] }) {
  if (communities.length === 0) {
    return (
      <p className="mt-3 text-sm text-fosforo-dim">
        Nenhuma comunidade sincronizada para esta conta ainda.
      </p>
    )
  }

  return (
    <ul className="mt-3 divide-y divide-risco/60">
      {communities.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fosforo">
              r/{c.name}
            </p>
            <p className="truncate text-xs text-fosforo-dim">{c.display_name}</p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {c.submission_type && (
              <span className={chip}>
                {TIPO_LABEL[c.submission_type] ?? c.submission_type}
              </span>
            )}
            {c.link_flair_enabled && <span className={chip}>flair</span>}
            {c.over_18 && (
              <span className="rounded-sm border border-ambar/35 bg-ambar/10 px-1.5 py-0.5 font-display uppercase tracking-[0.06em] text-ambar">
                +18
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
