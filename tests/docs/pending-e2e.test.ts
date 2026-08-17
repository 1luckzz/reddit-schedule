import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Garante que todo endpoint real do Reddit tem verificação manual listada.
 *
 * Enquanto a Data API não é aprovada, a única prova de que a integração
 * funciona é um roteiro humano — e um endpoint que ninguém lembrou de listar
 * é um endpoint que ninguém vai testar. Este teste falha quando alguém
 * adiciona uma chamada nova sem acrescentar a verificação correspondente.
 */

const README = readFileSync('README.md', 'utf8')
const PENDENTE = README.slice(
  README.indexOf('## Verificação pendente'),
  README.indexOf('## Estado atual'),
)

function arquivosTs(dir: string): string[] {
  const saida: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) saida.push(...arquivosTs(caminho))
    else if (entrada.name.endsWith('.ts')) saida.push(caminho)
  }
  return saida
}

/** Caminhos que o código realmente chama, com a parte estável do endpoint. */
const ENDPOINTS: [string, string][] = [
  ['/api/v1/authorize', 'OAuth: autorização'],
  ['/api/v1/access_token', 'OAuth: troca e renovação de token'],
  ['/api/v1/me', 'OAuth: identidade da conta'],
  ['/subreddits/mine/moderator', 'sincronização de comunidades'],
  ['link_flair_v2', 'leitura de flairs'],
  ['post_requirements', 'leitura de requisitos'],
  ['/api/submit', 'publicação'],
  ['/api/comment', 'comentário'],
  ['/submitted', 'reconciliação da revisão'],
]

describe('endpoints reais do Reddit', () => {
  const fontes = arquivosTs(join('src', 'lib', 'reddit'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

  it('cada endpoint da lista existe mesmo no código', () => {
    // Impede que a lista envelheça apontando para chamadas removidas — o que
    // faria o teste do README passar protegendo nada.
    for (const [caminho, nome] of ENDPOINTS) {
      expect(fontes, nome).toContain(caminho)
    }
  })

  it('não há chamada nova fora da lista', () => {
    // Contagem em vez de parsing: caminhos montados com template literal não
    // se deixam extrair de forma confiável, e o que interessa aqui é detectar
    // que alguém acrescentou uma chamada — não reconstruir a URL.
    //
    // Ao mudar este número, acrescente o endpoint em ENDPOINTS e o roteiro
    // correspondente no README.
    const chamadas = fontes.match(/path:\s*[`'"]/g) ?? []
    const urlsDiretas = fontes.match(/_URL = '/g) ?? []

    // 7 ocorrências de `path:`: seis endpoints do Reddit (submit, comment,
    // flairs, requirements, submitted, moderator) mais `/api/reddit`, que é
    // caminho de cookie e não uma chamada. E 3 URLs diretas de OAuth
    // (authorize, access_token, me).
    expect(chamadas.length).toBe(7)
    expect(urlsDiretas.length).toBe(3)
  })

  it('TODO endpoint tem verificação manual listada no README', () => {
    const faltando = ENDPOINTS.filter(([caminho]) => !PENDENTE.includes(caminho))
    expect(faltando.map(([, nome]) => nome)).toEqual([])
  })
})

describe('a seção de verificação pendente', () => {
  it('existe e não está vazia', () => {
    expect(PENDENTE.length).toBeGreaterThan(500)
  })

  it('deixa claro que nada foi validado contra a API real', () => {
    expect(PENDENTE).toMatch(/Nada aqui foi executado contra a API real/i)
  })

  it('avisa que a publicação escreve de verdade', () => {
    // O único bloco que produz efeito irreversível merece o aviso explícito.
    expect(PENDENTE).toMatch(/publica de verdade/i)
  })

  it('todos os itens continuam abertos enquanto a aprovação não sai', () => {
    const marcados = PENDENTE.match(/- \[x\]/gi) ?? []
    expect(marcados).toEqual([])
    expect((PENDENTE.match(/- \[ \]/g) ?? []).length).toBeGreaterThan(10)
  })
})
