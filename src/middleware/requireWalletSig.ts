/**
 * Wallet-signature auth middleware.
 *
 * Clients must include headers:
 *   X-Vektor-Sig:        base64 personal_message signature
 *   X-Vektor-Timestamp:  unix-ms timestamp used in the signed message
 *
 * Signed message format (utf-8):
 *   vektor-auth:{address}:{timestamp}
 *
 * The middleware rejects when:
 *   - headers are missing
 *   - timestamp is more than 5 minutes old (or in the future by >1 min)
 *   - signature does not recover to the :wallet route param
 */

import type { Request, RequestHandler } from 'express'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'

const MAX_AGE_MS = 5 * 60 * 1000
const FUTURE_SKEW_MS = 60 * 1000

/**
 * Params type used internally by the middleware. Express v5's
 * `ParamsDictionary` widens values to `string | string[]`; we deliberately
 * use a narrower `Record<string, string>` so the middleware is
 * assignment-compatible with handler signatures that have route-inferred
 * params (e.g. `{ wallet: string }`) — contravariance lets a middleware
 * that accepts the wider `Record<string, string>` slot into a handler
 * array whose `P` is the route-inferred shape.
 *
 * The `resolveWallet` callback uses an untyped `Request` so its inference
 * does not lock the surrounding `P` in Express's overload resolution.
 */
type Params = Record<string, string>

export function requireWalletSig(opts: {
  walletParam?: string
  resolveWallet?: (req: Request) => string | null | undefined
} = {}): RequestHandler<Params> {
  const walletParam = opts.walletParam ?? 'wallet'

  const handler: RequestHandler<Params> = async (req, res, next) => {
    try {
      const raw = opts.resolveWallet
        ? opts.resolveWallet(req as unknown as Request)
        : (req.params as Record<string, unknown>)[walletParam]
      const wallet = typeof raw === 'string' ? raw : null
      if (!wallet) {
        res.status(401).json({ ok: false, error: 'auth: missing wallet param' })
        return
      }

      const sig = req.header('x-vektor-sig')
      const tsHeader = req.header('x-vektor-timestamp')
      if (!sig || !tsHeader) {
        res.status(401).json({ ok: false, error: 'auth: missing signature headers' })
        return
      }

      const ts = Number(tsHeader)
      if (!Number.isFinite(ts)) {
        res.status(401).json({ ok: false, error: 'auth: bad timestamp' })
        return
      }

      const now = Date.now()
      if (ts > now + FUTURE_SKEW_MS || now - ts > MAX_AGE_MS) {
        res.status(401).json({ ok: false, error: 'auth: stale timestamp' })
        return
      }

      const message = new TextEncoder().encode(`vektor-auth:${wallet}:${ts}`)
      const pub = await verifyPersonalMessageSignature(message, sig)
      const recovered = pub.toSuiAddress()

      if (recovered.toLowerCase() !== wallet.toLowerCase()) {
        res.status(401).json({ ok: false, error: 'auth: signature does not match wallet' })
        return
      }

      next()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(401).json({ ok: false, error: `auth: ${msg}` })
    }
  }
  return handler
}

/**
 * Worker-secret bypass: accepts either a valid wallet signature OR a
 * matching X-Echo-Worker-Secret header (used by the echo-worker fetch path).
 */
export function requireWalletSigOrWorkerSecret(opts: {
  walletParam?: string
  envVar?: string
  resolveWallet?: (req: Request) => string | null | undefined
} = {}): RequestHandler<Params> {
  const sigGuard = requireWalletSig({
    walletParam:   opts.walletParam,
    resolveWallet: opts.resolveWallet,
  })
  const envVar = opts.envVar ?? 'ECHO_WORKER_SECRET'
  const handler: RequestHandler<Params> = async (req, res, next) => {
    const secret = process.env[envVar]
    const provided = req.header('x-echo-worker-secret')
    if (secret && provided && provided === secret) {
      next()
      return
    }
    await sigGuard(req, res, next)
  }
  return handler
}
