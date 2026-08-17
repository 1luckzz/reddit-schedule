/**
 * Vocabulário visual da sala de transmissão.
 *
 * Um único lugar para as classes que se repetem em todos os formulários e
 * módulos: reformar o console inteiro é editar este arquivo. Nada aqui lê
 * ambiente nem importa código de servidor — são só strings.
 */

/** Card/módulo de console. */
export const modulo = 'rounded-md border border-risco bg-console'

/** Rótulo gravado (eyebrow) acima de títulos e seções. */
export const plaqueta =
  'font-display text-[11px] font-medium uppercase tracking-[0.18em] text-fosforo-dim'

/** Título de página, em condensada caps. */
export const tituloPagina =
  'font-display text-[26px] leading-8 font-semibold uppercase tracking-[0.04em] text-fosforo'

/** Descrição sob o título. */
export const descricaoPagina = 'mt-1 text-sm text-fosforo-dim'

/** Campo de formulário (input, select, textarea). */
export const campo =
  'rounded-sm border border-risco bg-estudio px-2.5 py-1.5 text-sm text-fosforo transition-colors focus:border-ambar'

/** Rótulo de campo em plaqueta, empilhado sobre o controle. */
export const rotuloCampo =
  'flex flex-col gap-1 font-display text-[11px] font-medium uppercase tracking-[0.12em] text-fosforo-dim'

/** Ação primária: o botão âmbar do console. */
export const botaoPrimario =
  'rounded-sm bg-ambar px-3 py-2 font-display text-sm font-semibold uppercase tracking-[0.08em] text-estudio transition-opacity hover:opacity-90 disabled:opacity-50'

/** Ação secundária: contorno discreto. */
export const botaoFantasma =
  'rounded-sm border border-risco px-3 py-2 text-sm text-fosforo-dim transition-colors hover:bg-console-2 hover:text-fosforo disabled:opacity-50'

/** Cabeçalho de tabela. */
export const cabecalhoTabela =
  'border-b border-risco text-left font-display text-[11px] font-medium uppercase tracking-[0.12em] text-fosforo-dim'
