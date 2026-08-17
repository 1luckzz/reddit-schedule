import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/nav/sidebar'
import { requireUser, UnauthenticatedError } from '@/lib/auth/require-user'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let user: { id: string; email: string }
  try {
    user = await requireUser()
  } catch (e) {
    if (e instanceof UnauthenticatedError) redirect('/login')
    throw e
  }

  return (
    <div className="flex min-h-screen bg-estudio">
      <Sidebar email={user.email} />
      <main className="flex-1 overflow-x-auto p-8">{children}</main>
    </div>
  )
}
