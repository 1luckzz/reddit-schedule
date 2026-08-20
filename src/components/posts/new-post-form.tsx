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
  'mt-1.5 w-full rounded-lg border border-traco bg-fundo px-3 py-2 text-sm text-claro transition-colors placeholder:text-fraco focus:border-traco-forte'
const label = 'block text-[13px] font-medium text-medio'
/** Título de cada bloco do formulário. */
const secao = 'text-sm font-medium text-claro'

export function NewPostForm({
  accounts,
  communities,
  devvitCommunities = [],
}: {
  accounts: Account[]
  communities: Community[]
  /** Nomes (minúsculos) das comunidades com instalação Devvit ativa. */
  devvitCommunities?: string[]
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

  const comunidadeEscolhida = doAccount.find((c) => c.id === subredditId)
  const viaDevvit = Boolean(
    comunidadeEscolhida &&
      devvitCommunities.includes(comunidadeEscolhida.name.toLowerCase()),
  )
  const contaEscolhida = accounts.find((a) => a.id === accountId)

  return (
    <form action={action} className="mt-8 space-y-8">
      {/* ---------------- Destino ---------------- */}
      <section>
        <h2 className={secao}>Destino</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
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
              <p className="mt-1.5 text-xs text-areia">
                Esta conta ainda não tem comunidades sincronizadas.
              </p>
            )}
          </div>
        </div>

        {/*
          A identidade de publicação é decidida pelo backend, nunca aqui: o
          formulário apenas informa qual caminho esta comunidade usa. No
          caminho Devvit quem publica é o app (runAs APP), não a conta — a
          conta selecionada segue validando a comunidade e os flairs.
        */}
        {comunidadeEscolhida && (
          <div className="anima-painel mt-4 rounded-lg border border-traco bg-white/[0.03] p-3.5 text-sm">
            {viaDevvit ? (
              <>
                <p className="text-claro">
                  Publicador: <span className="font-medium">App Devvit</span>
                </p>
                <p className="mt-0.5 text-claro">
                  Será publicado em r/{comunidadeEscolhida.name}
                </p>
                <p className="mt-1.5 text-xs text-fraco">
                  A publicação será feita pelo aplicativo instalado na
                  comunidade, não pela conta u/
                  {contaEscolhida?.username ?? '—'}.
                </p>
              </>
            ) : (
              <p className="text-claro">
                Será publicado em r/{comunidadeEscolhida.name} por u/
                {contaEscolhida?.username ?? '—'}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ---------------- Conteúdo ---------------- */}
      <section className="border-t border-traco pt-6">
        <h2 className={secao}>Conteúdo</h2>
        <div className="mt-3 space-y-4">
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
            <div className="anima-painel rounded-lg border border-areia/30 bg-areia/10 p-3.5">
              <p className="text-sm text-claro">
                A API do Reddit não permite link e texto na mesma publicação.
                O texto pode ser enviado como comentário automático logo após a
                publicação.
              </p>
              <label className="mt-2.5 flex items-center gap-2 text-sm text-claro">
                <input type="checkbox" name="allowCommentFallback" />
                Enviar o texto como comentário automático
              </label>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
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
                <p className="mt-1.5 text-xs text-rosa" role="alert">
                  {flairErro}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-5 pb-2.5">
              <label className="flex items-center gap-2 text-sm text-claro">
                <input type="checkbox" name="nsfw" />
                Conteúdo adulto (NSFW)
              </label>
              <label className="flex items-center gap-2 text-sm text-claro">
                <input type="checkbox" name="spoiler" />
                Spoiler
              </label>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Programação ---------------- */}
      <section className="border-t border-traco pt-6">
        <h2 className={secao}>Programação</h2>
        <div className="mt-3 space-y-4">
          <div className="sm:max-w-xs">
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

          <fieldset>
            <legend className={label}>Publicação</legend>
            <div className="mt-2 flex flex-wrap gap-5">
              <label className="flex items-center gap-2 text-sm text-claro">
                <input
                  type="radio"
                  name="publishMode"
                  value="now"
                  checked={publishMode === 'now'}
                  onChange={() => setPublishMode('now')}
                />
                Publicar agora
              </label>
              <label className="flex items-center gap-2 text-sm text-claro">
                <input
                  type="radio"
                  name="publishMode"
                  value="schedule"
                  checked={publishMode === 'schedule'}
                  onChange={() => setPublishMode('schedule')}
                />
                Programar
              </label>
            </div>
          </fieldset>

          {/* Data e hora — só fazem sentido no modo programar */}
          {publishMode === 'schedule' && (
            <div className="anima-painel grid gap-4 sm:grid-cols-2">
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
            <div className="anima-painel rounded-lg border border-areia/30 bg-areia/10 p-3.5">
              <p className="text-sm text-claro">
                Este horário acontece duas vezes no dia escolhido, por causa do
                fim do horário de verão. Escolha qual delas usar:
              </p>
              <div className="mt-2.5 space-y-1.5">
                {state.timeChoices.map((c) => (
                  <label
                    key={c.index}
                    className="flex items-center gap-2 text-sm text-claro"
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
        </div>
      </section>

      {/* ---------------- Comentário automático ---------------- */}
      <section className="border-t border-traco pt-6">
        <label className="flex items-center gap-2 text-sm font-medium text-claro">
          <input
            type="checkbox"
            name="addComment"
            checked={addComment}
            onChange={(e) => setAddComment(e.target.checked)}
          />
          Adicionar comentário automático
        </label>

        {addComment && (
          <div className="anima-painel mt-4 space-y-4">
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

            <div className="grid gap-4 sm:grid-cols-2">
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
            </div>

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

            <p className="text-xs text-fraco">
              O comentário só é enviado depois que a publicação for concluída
              com sucesso, sempre pela mesma conta.
            </p>
          </div>
        )}
      </section>

      <div className="border-t border-traco pt-6">
        {state.error && (
          <p role="alert" className="mb-3 text-sm text-rosa">
            {state.error}
          </p>
        )}
        {state.postId && (
          <p className="mb-3 text-sm text-salvia">Publicação agendada.</p>
        )}

        <button
          disabled={pending}
          className="rounded-lg bg-forte px-4 py-2 text-sm font-medium text-fundo transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
        >
          {pending
            ? 'Salvando…'
            : publishMode === 'now'
              ? 'Publicar agora'
              : 'Programar publicação'}
        </button>
      </div>
    </form>
  )
}
