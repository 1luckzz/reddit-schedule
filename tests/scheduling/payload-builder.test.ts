// tests/scheduling/payload-builder.test.ts
import { describe, expect, it } from 'vitest'
import { buildPayload, PayloadError } from '@/lib/scheduling/payload-builder'
import { FIELD_DEFAULTS } from '@/lib/reddit/requirements'

const subreddit = {
  name: 'minhacomunidade',
  submissionType: 'any' as const,
  linkFlairEnabled: true,
}

const base = {
  title: 'Título válido',
  nsfw: false,
  spoiler: false,
  allowCommentFallback: true,
}

const req = (o: Partial<typeof FIELD_DEFAULTS> = {}) => ({
  ...FIELD_DEFAULTS,
  ...o,
})

describe('escolha do tipo de publicação', () => {
  it('título + link vira link post', () => {
    const p = buildPayload(
      { ...base, url: 'https://exemplo.com/v' },
      req(),
      subreddit,
    )
    expect(p.postKind).toBe('link')
    expect(p.url).toBe('https://exemplo.com/v')
    expect(p.body).toBeNull()
    expect(p.commentBody).toBeNull()
  })

  it('título + texto vira self post', () => {
    const p = buildPayload({ ...base, body: 'meu texto' }, req(), subreddit)
    expect(p.postKind).toBe('self')
    expect(p.body).toBe('meu texto')
    expect(p.url).toBeNull()
    expect(p.commentBody).toBeNull()
  })

  it('título + link + texto vira link post com o texto em comentário', () => {
    // A API do Reddit não aceita os dois na mesma submissão.
    const p = buildPayload(
      { ...base, url: 'https://exemplo.com/v', body: 'meu texto' },
      req(),
      subreddit,
    )
    expect(p.postKind).toBe('link')
    expect(p.url).toBe('https://exemplo.com/v')
    expect(p.body).toBeNull()
    expect(p.commentBody).toBe('meu texto')
  })

  it('sem link e sem texto é recusado', () => {
    expect(() => buildPayload(base, req(), subreddit)).toThrow(PayloadError)
  })

  it('link + texto sem confirmação do usuário é recusado', () => {
    // O redirecionamento para comentário precisa ser escolha consciente.
    expect(() =>
      buildPayload(
        {
          ...base,
          url: 'https://exemplo.com/v',
          body: 'texto',
          allowCommentFallback: false,
        },
        req(),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('restrições da comunidade', () => {
  it('recusa link post onde a comunidade só aceita texto', () => {
    expect(() =>
      buildPayload({ ...base, url: 'https://exemplo.com/v' }, req(), {
        ...subreddit,
        submissionType: 'self',
      }),
    ).toThrow(PayloadError)
  })

  it('recusa self post onde a comunidade só aceita link', () => {
    expect(() =>
      buildPayload({ ...base, body: 'texto' }, req(), {
        ...subreddit,
        submissionType: 'link',
      }),
    ).toThrow(PayloadError)
  })

  it('recusa link post quando o corpo é obrigatório', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://exemplo.com/v' },
        req({ bodyRestrictionPolicy: 'required' }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa self post quando o corpo não é permitido', () => {
    expect(() =>
      buildPayload(
        { ...base, body: 'texto' },
        req({ bodyRestrictionPolicy: 'notAllowed' }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('exige flair quando a comunidade exige', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://exemplo.com/v' },
        req({ isFlairRequired: true }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('aceita quando o flair exigido é fornecido', () => {
    const p = buildPayload(
      { ...base, url: 'https://exemplo.com/v', flairId: 'abc' },
      req({ isFlairRequired: true }),
      subreddit,
    )
    expect(p.flairId).toBe('abc')
  })
})

describe('validação do título', () => {
  it('recusa título abaixo do mínimo da comunidade', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'oi', url: 'https://exemplo.com/v' },
        req({ titleMinLength: 10 }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa título acima do máximo da comunidade', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'x'.repeat(60), url: 'https://exemplo.com/v' },
        req({ titleMaxLength: 50 }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa título com termo proibido', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'isto é proibido aqui', url: 'https://exemplo.com/v' },
        req({ titleBlacklistedStrings: ['proibido'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('a comparação de termo proibido ignora maiúsculas', () => {
    expect(() =>
      buildPayload(
        { ...base, title: 'isto é PROIBIDO', url: 'https://exemplo.com/v' },
        req({ titleBlacklistedStrings: ['proibido'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('validação do corpo', () => {
  it('recusa corpo com termo proibido', () => {
    expect(() =>
      buildPayload(
        { ...base, body: 'contém spam aqui' },
        req({ bodyBlacklistedStrings: ['spam'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('valida também o texto que vira comentário', () => {
    // O texto redirecionado continua sendo conteúdo do usuário.
    expect(() =>
      buildPayload(
        { ...base, url: 'https://exemplo.com/v', body: 'contém spam' },
        req({ bodyBlacklistedStrings: ['spam'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('validação do domínio', () => {
  it('recusa domínio fora da lista permitida', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://naopermitido.com/v' },
        req({ domainWhitelist: ['youtube.com'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('aceita domínio da lista permitida', () => {
    const p = buildPayload(
      { ...base, url: 'https://youtube.com/watch?v=1' },
      req({ domainWhitelist: ['youtube.com'] }),
      subreddit,
    )
    expect(p.url).toContain('youtube.com')
  })

  it('aceita subdomínio de domínio permitido', () => {
    const p = buildPayload(
      { ...base, url: 'https://www.youtube.com/watch?v=1' },
      req({ domainWhitelist: ['youtube.com'] }),
      subreddit,
    )
    expect(p.url).toContain('youtube.com')
  })

  it('recusa domínio da lista bloqueada', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'https://spam.com/v' },
        req({ domainBlacklist: ['spam.com'] }),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })

  it('recusa URL malformada', () => {
    expect(() =>
      buildPayload({ ...base, url: 'nao-e-url' }, req(), subreddit),
    ).toThrow(PayloadError)
  })

  it('recusa esquema que não é http nem https', () => {
    expect(() =>
      buildPayload(
        { ...base, url: 'javascript:alert(1)' },
        req(),
        subreddit,
      ),
    ).toThrow(PayloadError)
  })
})

describe('mensagens de erro', () => {
  it('todo erro aponta o campo e explica em português', () => {
    try {
      buildPayload(base, req(), subreddit)
      throw new Error('deveria ter lançado')
    } catch (e) {
      const erro = e as PayloadError
      expect(erro.field).toBeTruthy()
      expect(erro.userMessage.length).toBeGreaterThan(10)
      expect(erro.userMessage).not.toMatch(/undefined|null/)
    }
  })

  it('a recusa de link + texto explica a limitação da API', () => {
    try {
      buildPayload(
        {
          ...base,
          url: 'https://exemplo.com/v',
          body: 'texto',
          allowCommentFallback: false,
        },
        req(),
        subreddit,
      )
      throw new Error('deveria ter lançado')
    } catch (e) {
      expect((e as PayloadError).userMessage).toMatch(/coment/i)
    }
  })
})
