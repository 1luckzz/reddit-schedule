'use client'

import { useActionState } from 'react'
import {
  checkOnReddit,
  resolveReview,
  type ReviewState,
} from '@/app/(dashboard)/dashboard/review/actions'

export type ReviewRow = {
  id: string
  title: string
  review_reason: string | null
  submit_attempted_at: string | null
  scheduled_at: string
  timezone: string
  reddit_accounts: { username: string } | null
  subreddits: { name: string } | null
}

const inicial: ReviewState = {
  error: null,
  candidates: null,
  postId: null,
  ok: false,
}

/**
 * Traduz o código técnico para a linguagem de quem vai decidir.
 *
 * O código bruto não diz nada a quem precisa escolher entre "publicou" e "não
 * publicou" — e é justamente essa escolha que a tela pede.
 */
function explicarMotivo(codigo: string | null): string {
  switch (codigo) {
    case 'OUTCOME_UNKNOWN_WORKER_DIED':
      return 'O processo de publicação foi interrompido antes de confirmar o resultado.'
    case 'OUTCOME_UNKNOWN':
      return 'O Reddit não confirmou o resultado do envio.'
    case 'RATE_LIMITED':
      return 'O Reddit limitou as requisições durante o envio.'
    default:
      return 'O envio saiu, mas a resposta do Reddit não chegou.'
  }
}

const formatar = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR') : '—'

export function ReviewCard({ item }: { item: ReviewRow }) {
  const [consulta, verificar, verificando] = useActionState(
    checkOnReddit,
    inicial,
  )
  const [decisao, resolver, resolvendo] = useActionState(resolveReview, inicial)

  // A consulta só vale para este card: a action devolve o postId consultado.
  const candidatos =
    consulta.postId === item.id ? (consulta.candidates ?? null) : null

  return (
    <article className="rounded-lg border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
      <header>
        <h2 className="font-medium text-neutral-900 dark:text-neutral-50">
          {item.title}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          u/{item.reddit_accounts?.username ?? '—'} → r/
          {item.subreddits?.name ?? '—'}
          {' · '}
          tentativa em {formatar(item.submit_attempted_at)}
        </p>
      </header>

      <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
        {explicarMotivo(item.review_reason)}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <form action={verificar}>
          <input type="hidden" name="postId" value={item.id} />
          <button
            type="submit"
            disabled={verificando}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {verificando ? 'Consultando…' : 'Verificar no Reddit'}
          </button>
        </form>

        <form action={resolver}>
          <input type="hidden" name="postId" value={item.id} />
          <input type="hidden" name="decision" value="failed" />
          <button
            type="submit"
            disabled={resolvendo}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Não foi publicada
          </button>
        </form>
      </div>

      <p className="mt-2 text-xs text-neutral-500">
        A verificação apenas <strong>lê</strong> as publicações da conta no
        Reddit. Nada é reenviado, e a decisão é sua.
      </p>

      {consulta.error && consulta.postId === null && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {consulta.error}
        </p>
      )}
      {decisao.error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {decisao.error}
        </p>
      )}

      {candidatos !== null &&
        (candidatos.length === 0 ? (
          <p className="mt-4 rounded-md border border-neutral-200 bg-white p-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
            Nenhuma publicação compatível foi encontrada na conta dentro da
            janela de tempo. Isso sugere que o envio não chegou — mas confira
            antes de decidir.
          </p>
        ) : (
          <div className="mt-4">
            {candidatos.length > 1 && (
              <p className="mb-2 text-sm text-amber-800 dark:text-amber-300">
                Mais de uma publicação compatível. Confira cada uma: pode ter
                sido publicada em duplicidade.
              </p>
            )}
            <ul className="space-y-2">
              {candidatos.map((c) => (
                <li
                  key={c.redditFullname}
                  className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <p className="text-sm text-neutral-900 dark:text-neutral-50">
                    {c.title}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {formatar(new Date(c.createdAt).toISOString())}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-blue-600 underline dark:text-blue-400"
                    >
                      Abrir no Reddit
                    </a>
                    <form action={resolver}>
                      <input type="hidden" name="postId" value={item.id} />
                      <input type="hidden" name="decision" value="published" />
                      <input
                        type="hidden"
                        name="redditPostId"
                        value={c.redditPostId}
                      />
                      <input
                        type="hidden"
                        name="redditFullname"
                        value={c.redditFullname}
                      />
                      <input
                        type="hidden"
                        name="permalink"
                        value={c.permalink}
                      />
                      <button
                        type="submit"
                        disabled={resolvendo}
                        className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200"
                      >
                        É esta
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </article>
  )
}
