import {
  CalendarDays,
  Gauge,
  History,
  ListOrdered,
  PlusCircle,
  Radio,
  ScrollText,
  Settings,
  ShieldAlert,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = { href: string; label: string; icon: LucideIcon }

/**
 * As nove seções da spec mais Revisão, exigida pelo estado needs_review.
 * As páginas correspondentes chegam nos Planos 2 a 5.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: Gauge },
  { href: '/dashboard/new', label: 'Nova publicação', icon: PlusCircle },
  { href: '/dashboard/calendar', label: 'Calendário', icon: CalendarDays },
  { href: '/dashboard/queue', label: 'Fila', icon: ListOrdered },
  { href: '/dashboard/review', label: 'Revisão', icon: ShieldAlert },
  { href: '/dashboard/history', label: 'Histórico', icon: History },
  { href: '/dashboard/accounts', label: 'Contas Reddit', icon: Radio },
  { href: '/dashboard/communities', label: 'Comunidades', icon: Users },
  { href: '/dashboard/logs', label: 'Logs', icon: ScrollText },
  { href: '/dashboard/settings', label: 'Configurações', icon: Settings },
] as const
