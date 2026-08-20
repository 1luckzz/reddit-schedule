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

  // Destinos Devvit: instalações ativas do usuário (RLS). O formulário envia
  // só o id; publisher e subreddit são derivados no servidor.
  const { data: instalacoes } = await supabase
    .from('devvit_installations')
    .select('id, subreddit_name')
    .eq('status', 'active')
    .order('subreddit_name')

  return (
    <div className="anima-entrada max-w-3xl">
      <h1 className={tituloPagina}>Nova publicação</h1>
      <p className={descricaoPagina}>
        Agende uma publicação em uma das comunidades que você modera.
      </p>

      {(contas ?? []).length === 0 && (instalacoes ?? []).length === 0 ? (
        <div className={`${estadoVazio} mt-6`}>
          Conecte uma conta Reddit ou registre uma instalação do App Devvit
          antes de agendar.
        </div>
      ) : (
        <NewPostForm
          accounts={contas ?? []}
          communities={comunidades ?? []}
          devvitDestinations={(instalacoes ?? []).map((i) => ({
            id: i.id,
            subredditName: i.subreddit_name,
          }))}
        />
      )}
    </div>
  )
}
