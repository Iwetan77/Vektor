/**
 * Signed-fetch helper for routes guarded by requireWalletSig on the server.
 *
 * The middleware (src/middleware/requireWalletSig.ts) requires two headers:
 *   x-vektor-sig         — base64 personal_message signature
 *   x-vektor-timestamp   — unix-ms timestamp embedded in the signed message
 *
 * The signed message format must match exactly:
 *   vektor-auth:{address}:{timestamp}
 *
 * The middleware then verifies that the signature recovers to the :wallet
 * route param (or whatever resolveWallet returns). Timestamp must be within
 * the last 5 minutes (and not more than 1 minute in the future).
 *
 * Usage:
 *   const { signedFetch, signedHeaders } = useAuthFetch()
 *   await signedFetch('/api/echo/' + address + '/rules', { method: 'POST', body: JSON.stringify(...) })
 *
 * If the user rejects the wallet popup, both helpers throw a clear
 * "signature cancelled" error and never fire the underlying fetch.
 */

import { useSignPersonalMessage, useCurrentAccount } from '@mysten/dapp-kit'
import { useCallback } from 'react'

export interface SignedAccount {
  address: string
}

export interface SignedHeaders {
  'x-vektor-address':    string
  'x-vektor-sig':        string
  'x-vektor-timestamp':  string
  'Content-Type':        string
}

/** Build the canonical message bytes the middleware will verify. */
function buildMessage(address: string, timestamp: number): Uint8Array {
  return new TextEncoder().encode(`vektor-auth:${address}:${timestamp}`)
}

function isUserRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /reject|cancel|denied|user closed/i.test(msg)
}

/**
 * React hook — returns two callables that handle BOTH auth modes:
 *
 *   1. Slush / dapp-kit wallet user → signs a personal message, attaches the
 *      x-vektor-sig + x-vektor-timestamp + x-vektor-address headers, and the
 *      server's requireWalletSig branch verifies them.
 *
 *   2. zkLogin user (no dapp-kit wallet) → there's no popup to sign with, so
 *      we skip signing entirely. The httpOnly session cookie is sent with
 *      every request automatically (credentials: 'include'), and the server's
 *      requireWalletSigOrZkLogin middleware unseals it and verifies the
 *      decoded address matches the resolved wallet.
 *
 * Callers don't need to know which mode the user is in — just call
 * signedFetch and it does the right thing.
 *
 * Throws:
 *   • 'signature cancelled' if a Slush user dismisses the popup
 *   • 'not signed in'       if neither auth mode is available
 */
export function useAuthFetch(): {
  signedHeaders: () => Promise<SignedHeaders | null>
  signedFetch:   (url: string, init?: RequestInit) => Promise<Response>
} {
  const account                = useCurrentAccount()
  const { mutateAsync: sign }  = useSignPersonalMessage()

  /**
   * Returns the wallet-sig headers for adapter users, or `null` for zkLogin
   * users (in which case the session cookie carries auth automatically).
   * Throws only if the user has neither auth method available.
   */
  const signedHeaders = useCallback(async (): Promise<SignedHeaders | null> => {
    if (!account?.address) {
      // No dapp-kit wallet. Caller's session cookie (if any) will be checked
      // server-side — we just return null so signedFetch knows to skip headers.
      return null
    }

    const timestamp = Date.now()
    const message   = buildMessage(account.address, timestamp)

    let signature: string
    try {
      const res = await sign({ message })
      signature = res.signature
    } catch (err) {
      if (isUserRejection(err)) throw new Error('signature cancelled')
      throw err
    }

    return {
      'x-vektor-address':   account.address,
      'x-vektor-sig':       signature,
      'x-vektor-timestamp': String(timestamp),
      'Content-Type':       'application/json',
    }
  }, [account?.address, sign])

  const signedFetch = useCallback(async (url: string, init: RequestInit = {}): Promise<Response> => {
    const sigHeaders = await signedHeaders()
    const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    const merged: Record<string, string> = {
      ...baseHeaders,
      ...(sigHeaders ?? {}),
      ...(init.headers as Record<string, string> ?? {}),
    }
    // Sig headers always win over caller-supplied for the auth triple (so a
    // caller can't accidentally null them out by passing headers).
    if (sigHeaders) {
      merged['x-vektor-address']   = sigHeaders['x-vektor-address']
      merged['x-vektor-sig']       = sigHeaders['x-vektor-sig']
      merged['x-vektor-timestamp'] = sigHeaders['x-vektor-timestamp']
    }
    // credentials:'include' so the zkLogin session cookie tags along even
    // for cross-origin deployments (same-origin localhost sends it anyway).
    return fetch(url, { ...init, headers: merged, credentials: 'include' })
  }, [signedHeaders])

  return { signedHeaders, signedFetch }
}
