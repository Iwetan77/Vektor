/**
 * Express routes for zkLogin (Google → Shinami → Sui).
 *
 *   GET  /api/zklogin/epoch     — current Sui epoch (browser needs it to build the ephemeral session)
 *   GET  /api/zklogin/login     — 302 to Google with the ephemeral nonce
 *   GET  /api/zklogin/callback  — Google redirect; exchanges code → id_token → Shinami wallet → session cookie
 *   GET  /api/zklogin/me        — who is signed in (never returns JWT/salt)
 *   POST /api/zklogin/logout    — clear session cookie
 *   POST /api/zklogin/prepare   — build txBytes for the session.address (browser signs with ephemeral key)
 *   POST /api/zklogin/execute   — assemble proof + signature, submit on-chain
 *
 * Cookies are httpOnly (sameSite=lax). We don't pull cookie-parser in to avoid the dep —
 * the manual parser below is fine for our two cookies.
 */

import type { Express, Request, Response } from 'express'
import { randomBytes } from 'node:crypto'

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, toBase64 } from '@mysten/sui/utils'

import { exchangeCodeForIdToken, verifyGoogleIdToken, googleAuthUrl } from './zklogin-core/google.js'
import { getZkLoginWallet, createZkLoginProof } from './zklogin-core/shinami.js'
import { sealSession, openSession, SESSION_COOKIE } from './zklogin-core/session.js'
import { extendedEphemeralPublicKey, addressSeed, assembleSignature } from './zklogin-core/zklogin.js'

const OAUTH_STATE_COOKIE = 'zk_oauth_state'
const VEKTOR_UI_URL = process.env.VEKTOR_URL ?? 'http://localhost:5173'

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function readCookie(req: Request, name: string): string | undefined {
  return parseCookies(req.headers.cookie)[name]
}

function setCookie(res: Response, name: string, value: string, opts: { maxAgeSec: number }): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAgeSec}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  res.setHeader('Set-Cookie', [...(asArray(res.getHeader('Set-Cookie'))), parts.join('; ')])
}

function clearCookie(res: Response, name: string): void {
  const parts = [`${name}=`, 'Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  res.setHeader('Set-Cookie', [...(asArray(res.getHeader('Set-Cookie'))), parts.join('; ')])
}

function asArray(v: string | number | string[] | undefined): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v
  return [String(v)]
}

function suiNetwork(): 'mainnet' | 'testnet' | 'devnet' {
  const n = (process.env.SUI_NETWORK ?? 'mainnet') as 'mainnet' | 'testnet' | 'devnet'
  return n
}

function makeSuiClient(): SuiClient {
  const n = suiNetwork()
  return new SuiClient({ url: getFullnodeUrl(n), network: n })
}

export function registerZkLoginRoutes(app: Express): void {
  // ── GET /api/zklogin/epoch ───────────────────────────────────────────
  app.get('/api/zklogin/epoch', async (_req, res) => {
    try {
      const { epoch } = await makeSuiClient().getLatestSuiSystemState()
      res.json({ epoch: Number(epoch) })
    } catch (err) {
      res.status(502).json({ error: 'epoch fetch failed', detail: (err as Error).message })
    }
  })

  // ── GET /api/zklogin/login?nonce=… ───────────────────────────────────
  // Browser calls this after creating its ephemeral session.
  app.get('/api/zklogin/login', (req, res) => {
    const nonce = String(req.query.nonce ?? '')
    if (!nonce) { res.status(400).json({ error: 'nonce required' }); return }
    const state = randomBytes(16).toString('hex')
    setCookie(res, OAUTH_STATE_COOKIE, state, { maxAgeSec: 600 })
    try {
      res.redirect(googleAuthUrl({ nonce, state }))
    } catch (err) {
      res.status(500).json({ error: 'login init failed', detail: (err as Error).message })
    }
  })

  // ── GET /api/zklogin/callback?code=…&state=… ────────────────────────
  app.get('/api/zklogin/callback', async (req, res) => {
    const code     = String(req.query.code  ?? '')
    const state    = String(req.query.state ?? '')
    const expected = readCookie(req, OAUTH_STATE_COOKIE)

    if (!code || !state || !expected || state !== expected) {
      res.redirect(`${VEKTOR_UI_URL}?error=oauth_state`)
      return
    }
    try {
      const idToken          = await exchangeCodeForIdToken(code)
      const claims           = await verifyGoogleIdToken(idToken)
      const { address, salt } = await getZkLoginWallet(idToken)

      const token = sealSession({
        jwt:     idToken,
        salt,
        address,
        email:    claims.email,
        name:     claims.name,
        givenName: claims.given_name ?? (claims.name?.split(' ')[0]),
        picture:  claims.picture,
      })
      setCookie(res, SESSION_COOKIE, token, { maxAgeSec: 60 * 60 * 24 }) // 1 day
      clearCookie(res, OAUTH_STATE_COOKIE)
      res.redirect(VEKTOR_UI_URL)
    } catch (err) {
      console.error('[zklogin/callback]', (err as Error).message)
      res.redirect(`${VEKTOR_UI_URL}?error=oauth_exchange`)
    }
  })

  // ── GET /api/zklogin/me ──────────────────────────────────────────────
  app.get('/api/zklogin/me', (req, res) => {
    const s = openSession(readCookie(req, SESSION_COOKIE))
    if (!s) { res.json({ signedIn: false }); return }
    res.json({
      signedIn: true,
      address:  s.address,
      email:     s.email     ?? null,
      name:      s.name      ?? null,
      givenName: s.givenName ?? null,
      picture:   s.picture   ?? null,
    })
  })

  // ── POST /api/zklogin/logout ─────────────────────────────────────────
  app.post('/api/zklogin/logout', (_req, res) => {
    clearCookie(res, SESSION_COOKIE)
    res.json({ ok: true })
  })

  // ── POST /api/zklogin/prepare { to?, amountMist? } ────────────────────
  // Builds a demo SUI transfer from session.address to itself (or to `to` if given).
  // Real chat flows can call other PTB-building endpoints and just pass txBytes to /execute.
  app.post('/api/zklogin/prepare', async (req, res) => {
    const session = openSession(readCookie(req, SESSION_COOKIE))
    if (!session) { res.status(401).json({ error: 'not signed in' }); return }

    const body = (req.body ?? {}) as { to?: string; amountMist?: number | string }
    const recipient = (body.to ?? session.address).trim()
    const amount    = BigInt(body.amountMist ?? 1_000_000) // 0.001 SUI

    try {
      const client = makeSuiClient()
      const tx     = new Transaction()
      tx.setSender(session.address)
      const [coin] = tx.splitCoins(tx.gas, [amount])
      tx.transferObjects([coin], recipient)
      const txBytes = await tx.build({ client })
      res.json({ txBytesB64: toBase64(txBytes) })
    } catch (err) {
      res.status(500).json({ error: 'prepare failed', detail: (err as Error).message })
    }
  })

  // ── POST /api/zklogin/execute ────────────────────────────────────────
  // { txBytesB64, userSignature, ephemeralPubKeyB64, maxEpoch, randomness } → { digest }
  app.post('/api/zklogin/execute', async (req, res) => {
    const session = openSession(readCookie(req, SESSION_COOKIE))
    if (!session) { res.status(401).json({ error: 'not signed in' }); return }

    const { txBytesB64, userSignature, ephemeralPubKeyB64, maxEpoch, randomness } = req.body as {
      txBytesB64:         string
      userSignature:      string
      ephemeralPubKeyB64: string
      maxEpoch:           number
      randomness:         string
    }
    if (!txBytesB64 || !userSignature || !ephemeralPubKeyB64 || maxEpoch == null || !randomness) {
      res.status(400).json({ error: 'missing fields' })
      return
    }

    // sub + aud were verified at login; safe to read the (unverified-here) JWT payload for them.
    const claims = JSON.parse(
      Buffer.from(session.jwt.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; aud: string }

    try {
      const proofCore = await createZkLoginProof({
        jwt:                        session.jwt,
        maxEpoch,
        extendedEphemeralPublicKey: extendedEphemeralPublicKey(ephemeralPubKeyB64),
        jwtRandomness:              randomness,
        salt:                       session.salt,
      })

      const signature = assembleSignature({
        proof: {
          ...proofCore,
          addressSeed: addressSeed({ salt: session.salt, sub: claims.sub, aud: claims.aud }),
        },
        maxEpoch,
        userSignature,
      })

      const client = makeSuiClient()
      const result = await client.executeTransactionBlock({
        transactionBlock: fromBase64(txBytesB64),
        signature,
        options:          { showEffects: true },
      })
      res.json({ digest: result.digest })
    } catch (err) {
      console.error('[zklogin/execute]', (err as Error).message)
      res.status(502).json({ error: 'execute failed', detail: (err as Error).message })
    }
  })
}
