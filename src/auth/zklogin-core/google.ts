/**
 * Minimal Google OAuth (OpenID Connect) for zkLogin — SERVER side.
 *
 * Authorization-code flow with `response_type=code` + `scope=openid email profile`
 * + ephemeral `nonce` (so Google embeds it in the id_token — the prover binds
 * the proof to the ephemeral session via this nonce).
 *
 * Set up a Web OAuth client at https://console.cloud.google.com/apis/credentials
 * and add the redirect URI matching GOOGLE_REDIRECT_URI.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'

const AUTH_ENDPOINT  = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS    = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

export interface GoogleClaims {
  sub:             string
  email:           string
  email_verified?: boolean
  name?:           string
  given_name?:     string
  family_name?:    string
  picture?:        string
  aud:             string
  iss:             string
  exp:             number
  nonce?:          string
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export function googleAuthUrl(opts: { nonce: string; state: string }): string {
  const params = new URLSearchParams({
    client_id:     env('GOOGLE_CLIENT_ID'),
    redirect_uri:  env('GOOGLE_REDIRECT_URI'),
    response_type: 'code',
    scope:         'openid email profile',
    nonce:         opts.nonce,
    state:         opts.state,
    prompt:        'select_account',
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export async function exchangeCodeForIdToken(code: string): Promise<string> {
  const r = await fetch(TOKEN_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri:  env('GOOGLE_REDIRECT_URI'),
      grant_type:    'authorization_code',
    }),
  })
  if (!r.ok) throw new Error(`google token exchange ${r.status}: ${await r.text()}`)
  const j = (await r.json()) as { id_token?: string }
  if (!j.id_token) throw new Error('google token response had no id_token')
  return j.id_token
}

/** Verify a JWT signature + iss/aud/exp. Never trust an unverified JWT. */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleClaims> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer:   ['https://accounts.google.com', 'accounts.google.com'],
    audience: env('GOOGLE_CLIENT_ID'),
  })
  return payload as unknown as GoogleClaims
}
