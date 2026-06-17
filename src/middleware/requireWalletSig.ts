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

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'

const MAX_AGE_MS = 5 * 60 * 1000
const FUTURE_SKEW_MS = 60 * 1000

export function requireWalletSig(opts: {
  walletParam?: string
  resolveWallet?: (req: Request) => string | null | undefined
} = {}): RequestHandler<any> {
  const walletParam = opts.walletParam ?? 'wallet'

  const handler: RequestHandler<any> = async (req, res, next) => {
    try {
      const wallet = opts.resolveWallet
        ? opts.resolveWallet(req)
        : (req.params as Record<string, string>)[walletParam]
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
} = {}): RequestHandler<any> {
  const sigGuard = requireWalletSig({ walletParam: opts.walletParam, resolveWallet: opts.resolveWallet })
  const envVar = opts.envVar ?? 'ECHO_WORKER_SECRET'
  const handler: RequestHandler<any> = async (req, res, next) => {
    const secret = process.env[envVar]
    const provided = req.header('x-echo-worker-secret')
    if (secret && provided && provided === secret) {
      next()
      return
    }
    await (sigGuard as (req: Request, res: Response, next: NextFunction) => unknown)(req, res, next)
  }
  return handler
}
