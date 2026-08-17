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
    <article className="rounded-md border border-ambar/40 bg-ambar/[0.06] p-4">
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-1.5 size-2 shrink-0 rounded-full bg-ambar"
        />
        <div>
          <h2 className="font-medium text-fosforo">{item.title}</h2>
          <p className="mt-0.5 text-xs text-fosforo-dim">
            u/{item.reddit_accounts?.username ?? '—'} → r/
            {item.subreddits?.name ?? '—'}
            {' · '}
            tentativa em{' '}
            <span className="font-mono text-[11px]">
              {formatar(item.submit_attempted_at)}
            </span>
          </p>
        </div>
      </header>

      <p className="mt-3 text-sm text-fosforo">
        {explicarMotivo(item.review_reason)}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <form action={verificar}>
          <input type="hidden" name="postId" value={item.id} />
          <button
            type="submit"
            disabled={verificando}
            className="rounded-sm border border-ambar/50 px-3 py-1.5 font-display text-[13px] font-medium uppercase tracking-[0.08em] text-ambar transition-colors hover:bg-ambar/15 disabled:opacity-60"
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
            className={`${botaoFantasma} py-1.5 text-[13px]`}
          >
            Não foi publicada
          </button>
        </form>
      </div>

      <p className="mt-2 text-xs text-fosforo-dim">
        A verificação apenas <strong>lê</strong> as publicações da conta no
        Reddit. Nada é reenviado, e a decisão é sua.
      </p>

      {consulta.error && consulta.postId === null && (
        <p className="mt-3 text-sm text-tijolo" role="alert">
          {consulta.error}
        </p>
      )}
      {decisao.error && (
        <p className="mt-3 text-sm text-tijolo" role="alert">
          {decisao.error}
        </p>
      )}

      {candidatos !== null &&
        (candidatos.length === 0 ? (
          <p className="mt-4 rounded-sm border border-risco bg-console p-3 text-sm text-fosforo-dim">
            Nenhuma publicação compatível foi encontrada na conta dentro da
            janela de tempo. Isso sugere que o envio não chegou — mas confira
            antes de decidir.
          </p>
        ) : (
          <div className="mt-4">
            {candidatos.length > 1 && (
              <p className="mb-2 text-sm text-ambar">
                Mais de uma publicação compatível. Confira cada uma: pode ter
                sido publicada em duplicidade.
              </p>
            )}
            <ul className="space-y-2">
              {candidatos.map((c) => (
                <li
                  key={c.redditFullname}
                  className="rounded-sm border border-risco bg-console p-3"
                >
                  <p className="text-sm text-fosforo">{c.title}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-fosforo-dim">
                    {formatar(new Date(c.createdAt).toISOString())}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <a
                      href={c.permalink}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-standby underline transition-colors hover:text-fosforo"
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
                        className="rounded-sm bg-ambar px-3 py-1.5 font-display text-xs font-semibold uppercase tracking-[0.08em] text-estudio transition-opacity hover:opacity-90 disabled:opacity-60"
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
