// src/app/(dashboard)/dashboard/new/page.tsx
import { createServerSupabase } from '@/lib/supabase/server'
import { NewPostForm } from '@/components/posts/new-post-form'

export default async function NewPostPage() {
  const supabase = await createServerSupabase()

  const { data: contas } = await supabase
    .from('reddit_accounts')
    .select('id, username, status')
    .eq('status', 'connected')
    .order('username')

  const { data: comunidades } = await supabase
    .from('subreddits')
    .select('id, name, reddit_account_id, submission_type, link_flair_enabled')
    .eq('status', 'active')
    .order('name')

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
        Nova publicação
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Agende uma publicação em uma das comunidades que você modera.
      </p>

      {(contas ?? []).length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Conecte uma conta Reddit e sincronize as comunidades antes de agendar.
        </p>
      ) : (
        <NewPostForm
          accounts={contas ?? []}
          communities={comunidades ?? []}
        />
      )}
    </div>
  )
}
