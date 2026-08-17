'use client'

import { useActionState } from 'react'
import {
  checkOnReddit,
  resolveReview,
  type ReviewState,
} from '@/app/(dashboard)/dashboard/review/actions'
import { botaoFantasma } from '@/components/ui/estilo'

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
    <article className="rounded-xl border border-traco bg-superficie p-5 shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-colors duration-150 hover:border-traco-forte">
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-[7px] size-1.5 shrink-0 rounded-full bg-areia"
        />
        <div className="min-w-0">
          <h2 className="font-medium text-forte">{item.title}</h2>
          <p className="mt-0.5 text-[13px] text-fraco">
            u/{item.reddit_accounts?.username ?? '—'} → r/
            {item.subreddits?.name ?? '—'}
            {' · '}
            tentativa em{' '}
            <span className="tabular-nums">
              {formatar(item.submit_attempted_at)}
            </span>
          </p>
        </div>
      </header>

      <p className="mt-3 text-sm text-claro">
        {explicarMotivo(item.review_reason)}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <form action={verificar}>
          <input type="hidden" name="postId" value={item.id} />
          <button
            type="submit"
            disabled={verificando}
            className="rounded-lg border border-traco-forte px-3.5 py-2 text-sm font-medium text-claro transition-colors duration-150 hover:bg-white/5 active:scale-[0.98] disabled:opacity-60"
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
            className={botaoFantasma}
          >
            Não foi publicada
          </button>
        </form>
      </div>

      <p className="mt-2.5 text-xs text-fraco">
        A verificação apenas <strong>lê</strong> as publicações da conta no
        Reddit. Nada é reenviado, e a decisão é sua.
      </p>

      {consulta.error && consulta.postId === null && (
        <p className="mt-3 text-sm text-rosa" role="alert">
          {consulta.error}
        </p>
      )}
      {decisao.error && (
        <p className="mt-3 text-sm text-rosa" role="alert">
          {decisao.error}
        </p>
      )}

      {candidatos !== null &&
        (candidatos.length === 0 ? (
          <p className="anima-painel mt-4 rounded-lg border border-traco bg-eleva p-3.5 text-sm text-medio">
            Nenhuma publicação compatível foi encontrada na conta dentro da
            janela de tempo. Isso sugere que o envio não chegou — mas confira
            antes de decidir.
          </p>
        ) : (
          <div className="anima-painel mt-4">
            {candidatos.length > 1 && (
              <p className="mb-2 text-sm text-areia">
                Mais de uma publicação compatível. Confira cada uma: pode ter
                sido publicada em duplicidade.
              </p>
            )}
            <ul className="space-y-2">
              {candidatos.map((c) => (
                <li
                  key={c.redditFullname}
                  className="rounded-lg border border-traco bg-eleva p-3.5"
                >
                  <p className="text-sm text-claro">{c.title}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-fraco">
                    {formatar(new Date(c.createdAt).toISOString())}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-3">
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-medio underline underline-offset-2 transition-colors duration-150 hover:text-claro"
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
                        className="rounded-lg bg-forte px-3 py-1.5 text-xs font-medium text-fundo transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
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
