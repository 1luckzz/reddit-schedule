import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync(
  'src/app/(dashboard)/dashboard/review/page.tsx',
  'utf8',
)
const actions = readFileSync(
  'src/app/(dashboard)/dashboard/review/actions.ts',
  'utf8',
)
const card = readFileSync('src/components/review/review-card.tsx', 'utf8')

/** Remove comentários: as verificações são sobre código, não documentação. */
const codigo = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('página de revisão', () => {
  it('lê com o client do usuário, nunca com o admin', () => {
    expect(codigo(page)).toContain('createServerSupabase')
    expect(codigo(page)).not.toContain('createAdminSupabase')
  })

  it('mostra apenas itens em needs_review', () => {
    expect(codigo(page)).toContain("'needs_review'")
  })

  it('não seleciona colunas sensíveis', () => {
    for (const proibido of [
      'access_token',
      'refresh_token',
      'proxy_password',
      'proxy_host',
    ]) {
      expect(codigo(page), proibido).not.toContain(proibido)
    }
  })

  it('não filtra por owner na consulta: quem restringe é a RLS', () => {
    // Filtrar por owner no cliente daria a impressão de segurança sem ser a
    // barreira real — e esconderia uma policy afrouxada por engano.
    // Identificador inteiro: o nome da FK usada para desambiguar a junção
    // contém `owner_id` sem ser filtro.
    expect(codigo(page)).not.toMatch(/\bowner_id\b/)
  })
})

/**
 * Só o corpo de `checkOnReddit`, recortado da fonte já sem comentários — os
 * índices precisam vir da mesma string, senão o recorte sai deslocado.
 */
function blocoCheck(): string {
  const limpo = codigo(actions)
  return limpo.slice(
    limpo.indexOf('export async function checkOnReddit'),
    limpo.indexOf('const resolveSchema'),
  )
}

describe('actions de revisão', () => {
  it('o owner vem da sessão, nunca do formulário', () => {
    expect(codigo(actions)).toMatch(/p_owner_id:\s*user\.id/)
    expect(codigo(actions)).not.toMatch(/p_owner_id:\s*parsed\./)
  })

  it('o schema não aceita campo de owner vindo do cliente', () => {
    expect(codigo(actions)).not.toMatch(/owner(Id)?:\s*z\./i)
  })

  it('a verificação no Reddit é somente leitura', () => {
    const bloco = blocoCheck()
    expect(bloco).toContain('findCandidates')
    // Nada de submissão aqui: verificar não pode publicar.
    expect(bloco).not.toContain('submitPost')
    expect(bloco).not.toContain('submitComment')
    expect(bloco).not.toContain('resolve_needs_review')
  })

  it('a verificação confere posse antes de falar com o Reddit', () => {
    const bloco = blocoCheck()
    expect(bloco).toContain('requireUser')
    expect(bloco).toContain('owner_id !== user.id')
    expect(bloco).toContain('assertAccountAccess')
  })

  it('a resolução usa a RPC exclusiva do backend', () => {
    expect(codigo(actions)).toContain('resolve_needs_review')
    expect(codigo(actions)).toContain('createAdminSupabase')
  })

  it('a resolução só aceita os três desfechos manuais', () => {
    expect(codigo(actions)).toMatch(
      /z\.enum\(\['published',\s*'failed',\s*'cancelled'\]\)/,
    )
  })

  it('nenhuma action reenvia a publicação', () => {
    // O caminho de republicação simplesmente não existe nesta tela.
    for (const proibido of ['submitPost', 'submitComment', 'runPost']) {
      expect(codigo(actions), proibido).not.toContain(proibido)
    }
  })
})

describe('o card de revisão', () => {
  it('exige escolha explícita para marcar como publicada', () => {
    // Não existe botão que envie decision=published sem os identificadores.
    const publicados = [...card.matchAll(/value="published"/g)]
    expect(publicados.length).toBeGreaterThan(0)
    // Todo formulário que envia published carrega os identificadores junto.
    const formularios = card.split('<form').filter((f) => f.includes('"published"'))
    expect(formularios.length).toBe(publicados.length)
    for (const form of formularios) {
      expect(form).toContain('name="redditFullname"')
      expect(form).toContain('name="redditPostId"')
    }
  })

  it('avisa que a verificação é apenas leitura', () => {
    expect(card).toMatch(/apenas\s*<strong>lê<\/strong>/)
  })

  it('destaca a ambiguidade quando há mais de um candidato', () => {
    expect(card).toContain('candidatos.length > 1')
    expect(card).toMatch(/duplicidade/i)
  })

  it('não decide sozinho quando há um único candidato', () => {
    // Nada de auto-resolver: mesmo com um só, a pessoa clica em "É esta".
    expect(card).toContain('É esta')
    expect(card).not.toMatch(/useEffect/)
  })
})
