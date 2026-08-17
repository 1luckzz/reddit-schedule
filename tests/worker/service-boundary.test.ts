import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { makeServiceClient } from '@/lib/supabase/service-factory'

const FACTORY = 'src/lib/supabase/service-factory.ts'

const normalizar = (p: string) =>
  relative(process.cwd(), p).replaceAll('\\', '/')

/**
 * Lista recursivamente os arquivos de código de um diretório.
 *
 * Escrito à mão em vez de `fs.globSync`: a versão de @types/node deste projeto
 * ainda não a declara, e uma dependência nova só para isto não se justifica.
 */
function arquivosDe(dir: string, exts: string[]): string[] {
  const saida: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) {
      saida.push(...arquivosDe(caminho, exts))
    } else if (exts.some((e) => entrada.name.endsWith(e))) {
      saida.push(normalizar(caminho))
    }
  }
  return saida
}

/**
 * Remove comentários antes de qualquer verificação.
 *
 * Sem isto, um arquivo que EXPLICA por que não usa `process.env` ou
 * `next/headers` seria acusado de usá-los — e o teste passaria a punir
 * documentação. O que interessa é o código.
 */
function codigo(arquivo: string): string {
  return readFileSync(arquivo, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const ehServerOnly = (src: string) =>
  /^\s*import\s+['"]server-only['"]/m.test(src)
const usaNextHeaders = (src: string) => /from\s+['"]next\/headers['"]/.test(src)
const ehServerAction = (src: string) => /^\s*['"]use server['"]/.test(src)

describe('a factory é pura', () => {
  it('não lê process.env em lugar nenhum', () => {
    expect(codigo(FACTORY)).not.toContain('process.env')
  })

  it('não menciona a variável da chave secreta fora de comentário', () => {
    expect(codigo(FACTORY)).not.toContain('SUPABASE_SECRET_KEY')
  })

  it('não importa o módulo de ambiente', () => {
    expect(codigo(FACTORY)).not.toMatch(/from\s+['"].*config\/env['"]/)
  })

  it('usa exatamente a URL e a chave que recebeu', () => {
    // Prova que a factory não tem fonte alternativa de credencial.
    const c = makeServiceClient('http://exemplo.local', 'chave-de-teste')
    expect((c as unknown as { supabaseKey: string }).supabaseKey).toBe(
      'chave-de-teste',
    )
    expect((c as unknown as { supabaseUrl: string }).supabaseUrl).toBe(
      'http://exemplo.local',
    )
  })

  it('exige url e chave não vazias', () => {
    // Falhar cedo é melhor que um client mudo que erra 401 lá adiante.
    expect(() => makeServiceClient('', 'k')).toThrow()
    expect(() => makeServiceClient('http://exemplo.local', '')).toThrow()
  })
})

describe('quem pode ler a chave secreta', () => {
  const permitidos = new Set([
    // Validação de ambiente na subida.
    'src/lib/config/env.ts',
    // Invólucro do Next, protegido por server-only.
    'src/lib/supabase/admin.ts',
    // Invólucro do worker, fora da árvore de módulos do Next.
    'worker/supabase.ts',
  ])

  it('nenhum outro módulo do repositório lê SUPABASE_SECRET_KEY', () => {
    const arquivos = [
      ...arquivosDe('src', ['.ts', '.tsx']),
      ...arquivosDe('worker', ['.ts']),
    ]

    expect(arquivos.length).toBeGreaterThan(0)

    const infratores = arquivos.filter(
      (f) => !permitidos.has(f) && codigo(f).includes('SUPABASE_SECRET_KEY'),
    )
    expect(infratores).toEqual([])
  })

  it('os três permitidos de fato existem', () => {
    // Sem isto, a lista poderia envelhecer apontando para arquivos removidos e
    // o teste acima continuaria verde sem proteger nada.
    for (const f of permitidos) {
      expect(() => readFileSync(f, 'utf8'), f).not.toThrow()
    }
  })

  it('admin.ts continua marcado como server-only', () => {
    expect(ehServerOnly(codigo('src/lib/supabase/admin.ts'))).toBe(true)
  })

  it('o invólucro do worker NÃO é server-only, senão o worker não sobe', () => {
    // O pacote `server-only` lança fora do ambiente de servidor React.
    expect(ehServerOnly(codigo('worker/supabase.ts'))).toBe(false)
  })
})

// ---------------------------------------------------------------
// O grafo de imports a partir de cada arquivo 'use client'
// ---------------------------------------------------------------
// Verificar só o import direto não bastaria: um módulo intermediário traria o
// segredo de volta ao bundle do cliente sem nenhum teste reclamar.

function resolverImport(deArquivo: string, especificador: string) {
  const base = especificador.startsWith('@/')
    ? resolve('src', especificador.slice(2))
    : especificador.startsWith('.')
      ? resolve(dirname(deArquivo), especificador)
      : null
  if (!base) return null

  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      readFileSync(cand, 'utf8')
      return normalizar(cand)
    } catch {
      // não é este candidato
    }
  }
  return null
}

/**
 * Módulos alcançáveis a partir de `raiz`.
 *
 * Um módulo `'use server'` é fronteira: o Next o substitui por um stub de RPC
 * no bundle do cliente, e o corpo nunca é enviado. Atravessá-lo acusaria de
 * vazamento todo Client Component que chama uma server action — que é o
 * caminho correto, não o errado.
 */
function alcancaveis(raiz: string): Set<string> {
  const vistos = new Set<string>()
  const fila = [raiz]
  while (fila.length > 0) {
    const atual = fila.pop()!
    if (vistos.has(atual)) continue
    vistos.add(atual)

    const src = codigo(atual)
    if (atual !== raiz && ehServerAction(src)) continue

    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const alvo = resolverImport(atual, m[1])
      if (alvo) fila.push(alvo)
    }
  }
  return vistos
}

describe('nenhum módulo de cliente alcança o service client', () => {
  const clientes = arquivosDe('src', ['.ts', '.tsx']).filter((f) =>
    /^\s*['"]use client['"]/.test(codigo(f)),
  )

  it('há arquivos use client para examinar', () => {
    // Sem isto, um glob que parasse de casar faria o teste abaixo varrer lista
    // vazia e passar sem provar nada.
    expect(clientes.length).toBeGreaterThan(0)
  })

  it('nenhum deles chega a admin, à factory ou ao módulo de ambiente', () => {
    const proibidos = [
      'src/lib/supabase/admin.ts',
      'src/lib/supabase/service-factory.ts',
      'src/lib/config/env.ts',
    ]

    for (const cliente of clientes) {
      const grafo = alcancaveis(cliente)
      for (const proibido of proibidos) {
        expect(grafo.has(proibido), `${cliente} alcança ${proibido}`).toBe(
          false,
        )
      }
    }
  })

  it('CONTRAPROVA: o caminhador de fato encontra o que existe', () => {
    // Se `alcancaveis` estivesse quebrado, o teste acima passaria sempre.
    const grafo = alcancaveis('src/lib/reddit/reddit-client-factory.ts')
    expect(grafo.has('src/lib/supabase/admin.ts')).toBe(true)
    expect(grafo.has('src/lib/config/env.ts')).toBe(true)
  })

  it('CONTRAPROVA: a fronteira de server action é o que protege', () => {
    // Um Client Component chega à server action, e para ali. Se a fronteira
    // fosse ignorada, o teste principal acusaria falso positivo.
    const acao = 'src/app/(dashboard)/dashboard/communities/actions.ts'
    expect(ehServerAction(codigo(acao))).toBe(true)
    expect(
      alcancaveis('src/components/communities/sync-button.tsx').has(acao),
    ).toBe(true)
  })
})

describe('o núcleo do worker é utilizável fora do Next', () => {
  for (const modulo of [
    'src/lib/reddit/client-core.ts',
    'src/lib/reddit/budget-core.ts',
    'src/lib/reddit/tokens.ts',
    'src/lib/auth/ownership-types.ts',
    'src/lib/worker/load-account.ts',
    'src/lib/worker/consistency.ts',
    'worker/supabase.ts',
  ]) {
    it(`${modulo} não depende de sessão nem de server-only`, () => {
      // O grafo inteiro precisa estar limpo: basta um módulo intermediário com
      // a marca para o worker morrer na importação.
      for (const arquivo of alcancaveis(modulo)) {
        const src = codigo(arquivo)
        const onde = `${arquivo}, alcançado a partir de ${modulo}`
        expect(ehServerOnly(src), onde).toBe(false)
        expect(usaNextHeaders(src), onde).toBe(false)
      }
    })
  }

  it('CONTRAPROVA: a checagem acusa quando a marca existe', () => {
    // Sem isto, um `ehServerOnly` quebrado deixaria todos os casos passarem.
    expect(ehServerOnly(codigo('src/lib/supabase/admin.ts'))).toBe(true)
    expect(usaNextHeaders(codigo('src/lib/supabase/server.ts'))).toBe(true)
    // E não se deixa enganar por uma menção em comentário.
    expect(usaNextHeaders(codigo('src/lib/auth/ownership-types.ts'))).toBe(
      false,
    )
  })

  it('o factory do Next continua exigindo posse verificada', () => {
    const src = codigo('src/lib/reddit/reddit-client-factory.ts')
    expect(ehServerOnly(src)).toBe(true)
    expect(src).toContain('assertAccountAccess')
  })
})
