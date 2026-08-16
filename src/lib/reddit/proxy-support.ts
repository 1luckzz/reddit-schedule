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
