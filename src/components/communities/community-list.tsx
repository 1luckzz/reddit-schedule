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

const chip = 'rounded-md border border-traco bg-white/5 px-1.5 py-0.5 text-fraco'

export function CommunityList({ communities }: { communities: CommunityRow[] }) {
  if (communities.length === 0) {
    return (
      <p className="mt-3 text-sm text-medio">
        Nenhuma comunidade sincronizada para esta conta ainda.
      </p>
    )
  }

  return (
    <ul className="mt-3 divide-y divide-white/5">
      {communities.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-claro">
              r/{c.name}
            </p>
            <p className="truncate text-xs text-medio">{c.display_name}</p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {c.submission_type && (
              <span className={chip}>
                {TIPO_LABEL[c.submission_type] ?? c.submission_type}
              </span>
            )}
            {c.link_flair_enabled && <span className={chip}>flair</span>}
            {c.over_18 && (
              <span className="rounded-md border border-areia/30 bg-areia/10 px-1.5 py-0.5 text-areia">
                +18
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
