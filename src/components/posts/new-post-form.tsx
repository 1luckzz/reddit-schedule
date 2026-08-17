// src/components/posts/new-post-form.tsx
'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import { createScheduledPost } from '@/app/(dashboard)/dashboard/new/actions'
import type { CreateState } from '@/app/(dashboard)/dashboard/new/schema'
import { SUPPORTED_TIME_ZONES } from '@/lib/scheduling/timezone'

const initial: CreateState = {
  error: null,
  fieldError: null,
  postId: null,
  timeChoices: null,
}

type Account = { id: string; username: string; status: string }
type Community = {
  id: string
  name: string
  reddit_account_id: string
  submission_type: string | null
  link_flair_enabled: boolean
}
type Flair = { id: string; text: string; modOnly: boolean }

const field =
  'mt-1 w-full rounded-sm border border-risco bg-estudio px-3 py-2 text-sm text-fosforo transition-colors focus:border-ambar'
const label =
  'block font-display text-[11px] font-medium uppercase tracking-[0.12em] text-fosforo-dim'

export function NewPostForm({
  accounts,
  communities,
}: {
  accounts: Account[]
  communities: Community[]
}) {
  const [state, action, pending] = useActionState(createScheduledPost, initial)

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [subredditId, setSubredditId] = useState('')
  const [url, setUrl] = useState('')
  const [body, setBody] = useState('')
  const [addComment, setAddComment] = useState(false)
  const [commentMode, setCommentMode] = useState('immediate')
  const [publishMode, setPublishMode] = useState('schedule')

  const [flairs, setFlairs] = useState<Flair[]>([])
  const [flairErro, setFlairErro] = useState<string | null>(null)

  // Só as comunidades da conta escolhida.
  const doAccount = useMemo(
    () => communities.filter((c) => c.reddit_account_id === accountId),
    [communities, accountId],
  )

  /**
   * Trocar de conta invalida a comunidade escolhida — e isso é consequência
   * direta da ação do usuário, então mora no handler. Fazer em useEffect
   * dispararia um render em cascata a cada troca.
   */
  function trocarConta(novo: string) {
    setAccountId(novo)
    setSubredditId('')
    setFlairs([])
    setFlairErro(null)
  }

  // Flairs sob demanda, ao escolher a comunidade.
  useEffect(() => {
    if (!accountId || !subredditId) return
    let cancelado = false

    fetch(`/api/reddit/flairs?accountId=${accountId}&subredditId=${subredditId}`)
      .then(async (r) => {
        const json = await r.json()
        if (cancelado) return
        if (!r.ok) {
          // Nunca dizemos "não tem flair" quando não conseguimos verificar.
          setFlairs([])
          setFlairErro(json.erro ?? 'Não foi possível carregar os flairs.')
          return
        }
        setFlairs(json.flairs ?? [])
        setFlairErro(null)
      })
      .catch(() => {
        if (cancelado) return
        setFlairs([])
        setFlairErro('Não foi possível carregar os flairs.')
      })

    return () => {
      cancelado = true
    }
  }, [accountId, subredditId])

  const precisaComentario = url.trim() !== '' && body.trim() !== ''

  return (
    <form action={action} className="mt-6 space-y-5">
      {/* Conta */}
      <div>
        <label htmlFor="accountId" className={label}>
          Conta Reddit
        </label>
        <select
          id="accountId"
          name="accountId"
          required
          className={field}
          value={accountId}
          onChange={(e) => trocarConta(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              u/{a.username}
            </option>
          ))}
        </select>
      </div>

      {/* Comunidade — apenas as da conta escolhida */}
      <div>
        <label htmlFor="subredditId" className={label}>
          Comunidade
        </label>
        <select
          id="subredditId"
          name="subredditId"
          required
          className={field}
          value={subredditId}
          onChange={(e) => setSubredditId(e.target.value)}
        >
          <option value="">Selecione…</option>
          {doAccount.map((c) => (
            <option key={c.id} value={c.id}>
              r/{c.name}
            </option>
          ))}
        </select>
        {doAccount.length === 0 && (
          <p className="mt-1 text-xs text-ambar">
            Esta conta ainda não tem comunidades sincronizadas.
          </p>
        )}
      </div>

      {/* Título */}
      <div>
        <label htmlFor="title" className={label}>
          Título
        </label>
        <input
          id="title"
          name="title"
          required
          maxLength={300}
          className={field}
        />
      </div>

      {/* Link */}
      <div>
        <label htmlFor="url" className={label}>
          Link
        </label>
        <input
          id="url"
          name="url"
          type="url"
          placeholder="https://…"
          className={field}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      {/* Texto */}
      <div>
        <label htmlFor="body" className={label}>
          Texto do post
        </label>
        <textarea
          id="body"
          name="body"
          rows={8}
          className={field}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {/* Aviso da limitação da API */}
      {precisaComentario && (
        <div className="rounded-md border border-ambar/40 bg-ambar/10 p-3">
          <p className="text-sm text-fosforo">
            A API do Reddit não permite link e texto na mesma publicação.
            O texto pode ser enviado como comentário automático logo após a
            publicação.
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm text-fosforo">
            <input type="checkbox" name="allowCommentFallback" />
            Enviar o texto como comentário automático
          </label>
        </div>
      )}

      {/* Flair */}
      <div>
        <label htmlFor="flairId" className={label}>
          Flair
        </label>
        <select id="flairId" name="flairId" className={field}>
          <option value="">Sem flair</option>
          {flairs
            .filter((f) => !f.modOnly)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.text}
              </option>
            ))}
        </select>
        {flairErro && (
          <p className="mt-1 text-xs text-tijolo" role="alert">
            {flairErro}
          </p>
        )}
      </div>

      {/* Marcadores */}
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-fosforo">
          <input type="checkbox" name="nsfw" />
          Conteúdo adulto (NSFW)
        </label>
        <label className="flex items-center gap-2 text-sm text-fosforo">
          <input type="checkbox" name="spoiler" />
          Spoiler
        </label>
      </div>

      {/* Fuso */}
      <div>
        <label htmlFor="timeZone" className={label}>
          Fuso horário
        </label>
        <select
          id="timeZone"
          name="timeZone"
          className={field}
          defaultValue="America/Sao_Paulo"
        >
          {SUPPORTED_TIME_ZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      {/* Publicar agora vs. programar */}
      <fieldset>
        <legend className={label}>Publicação</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="publishMode"
            value="now"
            checked={publishMode === 'now'}
            onChange={() => setPublishMode('now')}
          />
          Publicar agora
        </label>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="publishMode"
            value="schedule"
            checked={publishMode === 'schedule'}
            onChange={() => setPublishMode('schedule')}
          />
          Programar
        </label>
      </fieldset>

      {/* Data e hora — só fazem sentido no modo programar */}
      {publishMode === 'schedule' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="date" className={label}>
              Data
            </label>
            <input id="date" name="date" type="date" className={field} />
          </div>
          <div>
            <label htmlFor="time" className={label}>
              Horário
            </label>
            <input id="time" name="time" type="time" className={field} />
          </div>
        </div>
      )}

      {/* Horário que acontece duas vezes: o usuário escolhe qual */}
      {state.timeChoices && (
        <div className="rounded-md border border-ambar/40 bg-ambar/10 p-3">
          <p className="text-sm text-fosforo">
            Este horário acontece duas vezes no dia escolhido, por causa do fim
            do horário de verão. Escolha qual delas usar:
          </p>
          <div className="mt-2 space-y-1">
            {state.timeChoices.map((c) => (
              <label
                key={c.index}
                className="flex items-center gap-2 text-sm text-fosforo"
              >
                <input
                  type="radio"
                  name="occurrence"
                  value={String(c.index)}
                  defaultChecked={c.index === 0}
                />
                {c.index === 0 ? 'Primeira ocorrência' : 'Segunda ocorrência'} (
                {c.offsetLabel})
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Comentário automático */}
      <div className="rounded-md border border-risco bg-console p-4">
        <label className="flex items-center gap-2 text-sm font-medium text-fosforo">
          <input
            type="checkbox"
            name="addComment"
            checked={addComment}
            onChange={(e) => setAddComment(e.target.checked)}
          />
          Adicionar comentário automático
        </label>

        {addComment && (
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="commentBody" className={label}>
                Texto do comentário
              </label>
              <textarea
                id="commentBody"
                name="commentBody"
                rows={4}
                className={field}
              />
            </div>

            <div>
              <label htmlFor="commentMode" className={label}>
                Quando comentar
              </label>
              <select
                id="commentMode"
                name="commentMode"
                className={field}
                value={commentMode}
                onChange={(e) => setCommentMode(e.target.value)}
              >
                <option value="immediate">
                  Imediatamente após a publicação
                </option>
                <option value="delay">Minutos depois da publicação</option>
                <option value="absolute">Em um horário específico</option>
              </select>
            </div>

            {commentMode === 'delay' && (
              <div>
                <label htmlFor="commentDelayMinutes" className={label}>
                  Minutos após a publicação
                </label>
                <input
                  id="commentDelayMinutes"
                  name="commentDelayMinutes"
                  type="number"
                  min={0}
                  className={field}
                />
              </div>
            )}

            {commentMode === 'absolute' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="commentDate" className={label}>
                    Data do comentário
                  </label>
                  <input
                    id="commentDate"
                    name="commentDate"
                    type="date"
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="commentTime" className={label}>
                    Horário do comentário
                  </label>
                  <input
                    id="commentTime"
                    name="commentTime"
                    type="time"
                    className={field}
                  />
                </div>
              </div>
            )}

            <p className="text-xs text-fosforo-dim">
              O comentário só é enviado depois que a publicação for concluída
              com sucesso, sempre pela mesma conta.
            </p>
          </div>
        )}
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-tijolo">
          {state.error}
        </p>
      )}
      {state.postId && (
        <p className="text-sm text-ok">Publicação agendada.</p>
      )}

      <button
        disabled={pending}
        className="rounded-sm bg-ambar px-4 py-2 font-display text-sm font-semibold uppercase tracking-[0.08em] text-estudio transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending
          ? 'Salvando…'
          : publishMode === 'now'
            ? 'Publicar agora'
            : 'Programar publicação'}
      </button>
    </form>
  )
}
