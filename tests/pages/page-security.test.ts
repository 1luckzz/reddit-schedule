import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Remove comentários: as verificações são sobre código, não documentação. */
const codigo = (arquivo: string) =>
  readFileSync(arquivo, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

function arquivosDe(dir: string, nome: string): string[] {
  const saida: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) saida.push(...arquivosDe(caminho, nome))
    else if (entrada.name === nome) {
      saida.push(relative(process.cwd(), caminho).replaceAll('\\', '/'))
    }
  }
  return saida
}

const PAGINAS = arquivosDe(join('src', 'app'), 'page.tsx')
const ACTIONS = arquivosDe(join('src', 'app'), 'actions.ts')

const fila = codigo('src/app/(dashboard)/dashboard/queue/page.tsx')
const historico = codigo('src/app/(dashboard)/dashboard/history/page.tsx')
const calendario = codigo('src/app/(dashboard)/dashboard/calendar/page.tsx')
const tabelaFila = codigo('src/components/queue/queue-table.tsx')
const tabelaHist = codigo('src/components/history/history-table.tsx')

const SENSIVEIS = [
  'access_token',
  'refresh_token',
  'proxy_password',
  'proxy_host',
  'proxy_username',
  'state_hash',
]

describe('TODAS as páginas do painel', () => {
  it('há páginas para examinar', () => {
    expect(PAGINAS.length).toBeGreaterThan(5)
  })

  it('nenhuma lê com o client administrativo', () => {
    // O admin ignora RLS. Uma página que o usasse mostraria dados de qualquer
    // dono se um único filtro fosse esquecido.
    for (const p of PAGINAS) {
      expect(codigo(p), p).not.toContain('createAdminSupabase')
    }
  })

  it('nenhuma seleciona coluna sensível', () => {
    // Identificador inteiro, e não substring: `proxy_host_masked` é
    // justamente a coluna derivada e segura, criada no Plano 2 para que a
    // interface mostre a rota sem tocar no host real. Buscar por pedaço
    // acusaria exatamente a solução do problema.
    for (const p of PAGINAS) {
      for (const s of SENSIVEIS) {
        expect(codigo(p), `${p} contém ${s}`).not.toMatch(
          new RegExp(`\\b${s}\\b`),
        )
      }
    }
  })

  it('nenhuma publica nem comenta no Reddit', () => {
    // Ler é o único verbo permitido nas telas de visualização.
    for (const p of PAGINAS) {
      for (const proibido of ['submitPost', 'submitComment', 'runPost']) {
        expect(codigo(p), `${p} usa ${proibido}`).not.toContain(proibido)
      }
    }
  })

  it('nenhuma filtra por owner_id à mão', () => {
    // Quem restringe é a RLS. Filtrar na consulta daria aparência de segurança
    // e esconderia uma policy afrouxada por engano.
    //
    // Identificador inteiro de novo: os nomes de chave estrangeira usados para
    // desambiguar junções — `scheduled_posts_subreddit_id_owner_id_fkey` —
    // contêm `owner_id` sem serem filtro nenhum.
    for (const p of PAGINAS) {
      expect(codigo(p), p).not.toMatch(/\bowner_id\b/)
    }
  })
})

describe('as próprias checagens deste arquivo', () => {
  const acusa = (src: string, s: string) => new RegExp(`\\b${s}\\b`).test(src)

  it('CONTRAPROVA: acusa o identificador real e ignora o derivado', () => {
    // Sem isto, um regex quebrado deixaria todas as páginas passarem.
    expect(acusa("select('proxy_host, porta')", 'proxy_host')).toBe(true)
    expect(acusa("select('proxy_host_masked')", 'proxy_host')).toBe(false)
    expect(acusa("select('access_token_enc')", 'access_token')).toBe(false)
    expect(acusa("select('access_token')", 'access_token')).toBe(true)
  })

  it('CONTRAPROVA: a checagem de owner_id acusa filtro e ignora nome de FK', () => {
    expect(acusa(".eq('owner_id', user.id)", 'owner_id')).toBe(true)
    expect(
      acusa('subreddits!scheduled_posts_subreddit_id_owner_id_fkey', 'owner_id'),
    ).toBe(false)
  })

  it('nenhum regex deste arquivo contém caractere de controle', () => {
    // Um `\\b` escrito como byte 0x08 vira um regex que NUNCA casa, e a
    // verificação inteira passa a aprovar qualquer coisa em silêncio. Já
    // aconteceu aqui.
    const proprio = readFileSync(
      'tests/pages/page-security.test.ts',
      'utf8',
    )
    const controle = [...proprio].filter((c) => {
      const n = c.charCodeAt(0)
      return n < 9 || (n > 10 && n < 13) || (n > 13 && n < 32)
    })
    expect(controle).toEqual([])
  })
})

describe('TODAS as server actions', () => {
  it('há actions para examinar', () => {
    expect(ACTIONS.length).toBeGreaterThan(3)
  })

  it('nenhuma aceita owner vindo do formulário', () => {
    for (const a of ACTIONS) {
      const src = codigo(a)
      expect(src, a).not.toMatch(/owner(_?[iI]d)?\s*:\s*z\./)
      expect(src, a).not.toMatch(/p_owner_id:\s*(parsed|formData|data)\./)
    }
  })

  it('as que passam owner o derivam da sessão', () => {
    for (const a of ACTIONS) {
      const src = codigo(a)
      if (!src.includes('p_owner_id')) continue
      expect(src, a).toMatch(/p_owner_id:\s*user\.id/)
      expect(src, a).toContain('requireUser')
    }
  })
})

describe('página de Fila', () => {
  it('lê com o client do usuário', () => {
    expect(fila).toContain('createServerSupabase')
  })

  it('aplica os filtros na CONSULTA, não depois no cliente', () => {
    for (const filtro of [
      "eq('reddit_account_id'",
      "eq('subreddit_id'",
      "gte('scheduled_at'",
      "lte('scheduled_at'",
    ]) {
      expect(fila, filtro).toContain(filtro)
    }
  })

  it('valida os parâmetros da URL antes de usá-los', () => {
    // Um valor inesperado é ignorado em vez de ir para a consulta.
    expect(fila).toContain('UUID.test')
    expect(fila).toContain('DATA.test')
    expect(fila).toContain('POST_STATUSES')
  })

  it('mostra apenas o que ainda vai acontecer, por padrão', () => {
    expect(fila).toContain('QUEUE_STATUSES')
  })
})

describe('tabela de Fila', () => {
  it('só oferece reagendar e cancelar quando o estado permite', () => {
    expect(tabelaFila).toContain('podeEditar(item.status)')
    expect(tabelaFila).toContain('editavel ?')
  })

  it('as ações são as do Plano 4, não caminhos novos', () => {
    expect(tabelaFila).toContain('cancelPost')
    expect(tabelaFila).toContain('reschedulePost')
  })

  it('não existe botão de republicar', () => {
    expect(tabelaFila).not.toMatch(/republicar|reenviar|tentar de novo/i)
  })
})

describe('página de Histórico', () => {
  it('mostra apenas os estados terminais', () => {
    expect(historico).toContain('HISTORY_STATUSES')
    expect(historico).not.toContain('QUEUE_STATUSES')
  })

  it('mostra horário planejado e horário real lado a lado', () => {
    expect(tabelaHist).toContain('Planejado')
    expect(tabelaHist).toContain('Real')
    expect(tabelaHist).toContain('scheduled_at')
    expect(tabelaHist).toContain('published_at')
  })

  it('o link externo isola a aba de destino', () => {
    // Sem `noopener`, a página aberta pode manipular a nossa via window.opener.
    expect(tabelaHist).toContain('target="_blank"')
    expect(tabelaHist).toMatch(/rel="noreferrer noopener"|rel="noopener noreferrer"/)
  })

  it('marca o que foi resolvido manualmente', () => {
    expect(tabelaHist).toContain('resolved_at')
    expect(tabelaHist).toMatch(/resolvido manualmente/i)
  })

  it('exibe a mensagem humana, não o código do erro', () => {
    expect(tabelaHist).toContain('error_message')
    expect(tabelaHist).not.toContain('error_code')
  })

  it('não oferece nenhuma ação: é histórico', () => {
    expect(tabelaHist).not.toContain('useActionState')
    expect(tabelaHist).not.toContain('<form')
  })
})

describe('página de Calendário', () => {
  it('agrupa no fuso escolhido, nunca no do servidor', () => {
    expect(calendario).toContain('groupByDay')
    expect(calendario).toContain('fuso')
    // Nada de getDate()/getHours() locais, que trariam o fuso da máquina.
    expect(calendario).not.toMatch(/\.getDate\(\)|\.getHours\(\)/)
  })

  it('valida mês e fuso vindos da URL', () => {
    expect(calendario).toContain('SUPPORTED_TIME_ZONES')
    expect(calendario).toMatch(/Number\(params\.month\) >= 1/)
  })

  it('consulta a janela da grade, não só a do mês', () => {
    // As células vizinhas também mostram publicações.
    expect(calendario).toContain('grade[0].date')
    expect(calendario).toContain('grade[grade.length - 1].date')
  })
})
