/**
 * Protocolos de proxy confirmados por teste de integração real contra a versão
 * instalada do undici (tests/reddit/proxy-support.test.ts), que sobe proxies
 * locais e verifica que o tráfego atravessou cada um deles.
 *
 * Ajuste esta lista APENAS com o teste correspondente passando. A validação
 * Zod e o seletor da UI derivam daqui, então remover um protocolo daqui o
 * remove de todo o produto — que é exatamente o comportamento desejado se
 * algum deles deixar de funcionar.
 */
export const SUPPORTED_PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const

export type ProxyProtocol = (typeof SUPPORTED_PROXY_PROTOCOLS)[number]

/**
 * Protocolos que funcionam hoje, mas cujo suporte o próprio undici declara
 * instável. Verificado em 2026-08-16 com undici 8.10.0, que emite:
 *
 *   ExperimentalWarning: SOCKS5 proxy support is experimental and subject to
 *   change
 *
 * A travessia foi comprovada por teste real, então o suporte é verdadeiro —
 * mas uma atualização de undici pode alterá-lo sem aviso de breaking change.
 * O teste de travessia é a rede de proteção: se quebrar, o protocolo sai
 * daqui em vez de virar promessa vazia.
 */
export const EXPERIMENTAL_PROXY_PROTOCOLS: readonly ProxyProtocol[] = ['socks5']

export function isExperimentalProtocol(protocol: ProxyProtocol): boolean {
  return EXPERIMENTAL_PROXY_PROTOCOLS.includes(protocol)
}
