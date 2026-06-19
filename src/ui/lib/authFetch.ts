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
 * React hook — wraps useSignPersonalMessage() and returns two callables:
 *   • signedHeaders(): produce a fresh-timestamp set of headers
 *   • signedFetch(url, init): like fetch() but pre-signed
 *
 * Both throw `signature cancelled` if the user dismisses the wallet popup,
 * and `wallet not connected` if no account is connected.
 */
export function useAuthFetch(): {
  signedHeaders: () => Promise<SignedHeaders>
  signedFetch:   (url: string, init?: RequestInit) => Promise<Response>
} {
  const account                = useCurrentAccount()
  const { mutateAsync: sign }  = useSignPersonalMessage()

  const signedHeaders = useCallback(async (): Promise<SignedHeaders> => {
    if (!account?.address) throw new Error('wallet not connected')

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
    const merged: HeadersInit = { ...sigHeaders, ...(init.headers as Record<string, string> ?? {}) }
    // Caller-supplied Content-Type wins (e.g. multipart). Our sig headers always present.
    merged['x-vektor-address']   = sigHeaders['x-vektor-address']
    merged['x-vektor-sig']       = sigHeaders['x-vektor-sig']
    merged['x-vektor-timestamp'] = sigHeaders['x-vektor-timestamp']
    return fetch(url, { ...init, headers: merged })
  }, [signedHeaders])

  return { signedHeaders, signedFetch }
}
