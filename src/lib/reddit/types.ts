export type RedditTokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope: string
}

export type RedditIdentity = {
  id: string
  name: string
}

export type RedditApiEnvelope = {
  json?: {
    errors?: [string, string, string?][]
    data?: Record<string, unknown>
  }
}

export type RateLimitSnapshot = {
  used: number | null
  remaining: number | null
  resetSeconds: number | null
}
