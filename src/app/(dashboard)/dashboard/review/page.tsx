import { createServerSupabase } from '@/lib/supabase/server'
import { ReviewCard, type ReviewRow } from '@/components/review/review-card'
import {
  descricaoPagina,
  plaqueta,
  tituloPagina,
} from '@/components/ui/estilo'

export default async function ReviewPage() {
  const supabase = await createServerSupabase()

  // Client do usuário: a RLS restringe as linhas. Nenhuma coluna sensível é
  // selecionada — a página não precisa de token nem de configuração de rede.
  const { data: itens } = await supabase
    .from('scheduled_posts')
    .select(
      `id, title, review_reason, submit_attempted_at, scheduled_at, timezone,
       reddit_accounts ( username ),
       subreddits!scheduled_posts_subreddit_id_owner_id_fkey ( name )`,
    )
    .eq('status', 'needs_review')
    .order('submit_attempted_at', { ascending: false })

  const lista = (itens ?? []) as unknown as ReviewRow[]

  return (
    <div className="max-w-3xl">
      <p className={plaqueta}>Mesa de incidentes</p>
      <h1 className={tituloPagina}>Revisão</h1>
      <p className={descricaoPagina}>
        Publicações cujo resultado não pôde ser confirmado. O sistema não tenta
        de novo sozinho, porque isso poderia publicar duas vezes.
      </p>

      {lista.length === 0 ? (
        <p className="mt-8 text-sm text-fosforo-dim">Nada aguardando revisão.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {lista.map((item) => (
            <li key={item.id}>
              <ReviewCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
