/**
 * Vocabulário visual do tema Grafite.
 *
 * Um único lugar para as classes que se repetem em formulários, módulos e
 * tabelas: reformar o painel inteiro é editar este arquivo. Nada aqui lê
 * ambiente nem importa código de servidor — são só strings.
 */

/** Card padrão: borda suave, sombra discreta, superfície um passo acima. */
export const modulo =
  'rounded-xl border border-traco bg-superficie shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-colors'

/** Rótulo de seção. */
export const plaqueta = 'text-[13px] font-medium text-medio'

/** Título de página: um dos poucos lugares do branco pleno. */
export const tituloPagina =
  'text-xl font-semibold tracking-[-0.01em] text-forte'

/** Descrição sob o título. */
export const descricaoPagina = 'mt-1 text-sm text-medio'

/** Campo de formulário (input, select, textarea). */
export const campo =
  'h-9 rounded-lg border border-traco bg-fundo px-3 text-sm text-claro transition-colors placeholder:text-fraco focus:border-traco-forte'

/** Rótulo de campo empilhado sobre o controle. */
export const rotuloCampo =
  'flex flex-col gap-1.5 text-[13px] font-medium text-medio'

/** Ação primária: o único elemento branco sólido da tela. */
export const botaoPrimario =
  'rounded-lg bg-forte px-3.5 py-2 text-sm font-medium text-fundo transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50'

/** Ação secundária: contorno que clareia no hover. */
export const botaoFantasma =
  'rounded-lg border border-traco px-3.5 py-2 text-sm text-medio transition-colors duration-150 hover:border-traco-forte hover:text-claro active:scale-[0.98] disabled:opacity-50'

/** Ação destrutiva: rosa-seco discreto, nunca vermelho vivo. */
export const botaoPerigo =
  'rounded-lg border border-rosa/30 px-3.5 py-2 text-sm text-rosa transition-colors duration-150 hover:border-rosa/50 hover:bg-rosa/10 active:scale-[0.98] disabled:opacity-50'

/** Cabeçalho de tabela: pequeno, médio, sem gritar. */
export const cabecalhoTabela =
  'border-b border-traco text-left text-xs font-medium text-fraco'

/**
 * Estado vazio: composição própria — borda tracejada, centrado, com espaço
 * para uma ação. Deliberadamente diferente de um card de conteúdo.
 */
export const estadoVazio =
  'rounded-xl border border-dashed border-traco px-6 py-12 text-center text-sm text-medio'
