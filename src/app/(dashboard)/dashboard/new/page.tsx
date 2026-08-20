// src/app/(dashboard)/dashboard/new/page.tsx
import { createServerSupabase } from '@/lib/supabase/server'
import { NewPostForm } from '@/components/posts/new-post-form'
import {
  descricaoPagina,
  estadoVazio,
  tituloPagina,
} from '@/components/ui/estilo'

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

  // Comunidades com instalação Devvit ativa: nelas a publicação sai pelo App
  // Devvit, automaticamente — o formulário só informa, não deixa escolher.
  const { data: instalacoes } = await supabase
    .from('devvit_installations')
    .select('subreddit_name')
    .eq('status', 'active')

  return (
    <div className="anima-entrada max-w-3xl">
      <h1 className={tituloPagina}>Nova publicação</h1>
      <p className={descricaoPagina}>
        Agende uma publicação em uma das comunidades que você modera.
      </p>

      {(contas ?? []).length === 0 ? (
        <div className={`${estadoVazio} mt-6`}>
          Conecte uma conta Reddit e sincronize as comunidades antes de agendar.
        </div>
      ) : (
        <NewPostForm
          accounts={contas ?? []}
          communities={comunidades ?? []}
          devvitCommunities={(instalacoes ?? []).map((i) => i.subreddit_name)}
        />
      )}
    </div>
  )
}
