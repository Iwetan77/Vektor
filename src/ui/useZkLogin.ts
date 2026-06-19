/**
 * useZkLogin — browser half of the zkLogin flow.
 *
 *   • Server (Express) owns: JWT, salt, address (in an httpOnly session cookie),
 *     and the Shinami proof minting.
 *   • Browser owns: the EPHEMERAL Ed25519 key — kept in sessionStorage and never
 *     sent to the server. That's the key that signs txBytes; we hand the server
 *     only the resulting signature.
 *
 * Ported from sucker-punch's Next.js hook to Vite/React 18 (no "use client",
 * fetches go through vite proxy to :3001).
 */

import { useCallback, useEffect, useState } from 'react'
import { fromBase64 } from '@mysten/sui/utils'
import {
  createEphemeralSession,
  signTxBytes,
  type EphemeralSession,
} from '../auth/zklogin-core/zklogin.js'

const EPH_KEY = 'vektor.zk.ephemeral'

function loadEphemeral(): EphemeralSession | null {
  try { return JSON.parse(sessionStorage.getItem(EPH_KEY) ?? 'null') }
  catch { return null }
}
function saveEphemeral(s: EphemeralSession): void {
  sessionStorage.setItem(EPH_KEY, JSON.stringify(s))
}

export interface ZkUser {
  address:   string
  email:     string | null
  name:      string | null
  givenName: string | null
  picture:   string | null
}

export interface ZkLoginState {
  user:    ZkUser | null
  loading: boolean
  signIn:  () => Promise<void>
  signOut: () => Promise<void>
  /** Send a demo transfer end-to-end — returns the on-chain digest. */
  send:    (opts?: { to?: string; amountMist?: number }) => Promise<string>
  /** Sign already-built TransactionData bytes (BCS) and submit. Returns digest. */
  signAndExecuteBytes: (txBytesB64: string) => Promise<string>
  refresh: () => Promise<void>
}

export function useZkLogin(): ZkLoginState {
  const [user,    setUser]    = useState<ZkUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/zklogin/me').then(r => r.json())
      setUser(r.signedIn ? {
        address:   r.address,
        email:     r.email,
        name:      r.name,
        givenName: r.givenName ?? (r.name ? String(r.name).split(' ')[0] : null),
        picture:   r.picture ?? null,
      } : null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /** Create ephemeral session locally, then bounce to Google. */
  const signIn = useCallback(async () => {
    const { epoch } = await fetch('/api/zklogin/epoch').then(r => r.json())
    const eph       = createEphemeralSession(Number(epoch))
    saveEphemeral(eph)
    window.location.href = `/api/zklogin/login?nonce=${encodeURIComponent(eph.nonce)}`
  }, [])

  const signOut = useCallback(async () => {
    sessionStorage.removeItem(EPH_KEY)
    await fetch('/api/zklogin/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
  }, [])

  /**
   * prepare → sign locally with ephemeral key → execute. Returns the digest.
   * Real chat-driven flows will call other PTB-building endpoints and reuse
   * this function's sign+execute half — only the prepare URL differs.
   */
  const send = useCallback(
    async (opts?: { to?: string; amountMist?: number }): Promise<string> => {
      const eph = loadEphemeral()
      if (!eph) throw new Error('No ephemeral session — sign in again.')

      const { txBytesB64 } = await fetch('/api/zklogin/prepare', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(opts ?? {}),
      }).then(r => r.json())

      const userSignature = await signTxBytes(eph, fromBase64(txBytesB64))

      const res = await fetch('/api/zklogin/execute', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          txBytesB64,
          userSignature,
          ephemeralPubKeyB64: eph.publicKeyB64,
          maxEpoch:           eph.maxEpoch,
          randomness:         eph.randomness,
        }),
      }).then(r => r.json())

      if (!res.digest) throw new Error(res.detail ?? res.error ?? 'execute failed')
      return res.digest as string
    },
    [],
  )

  /**
   * Sign already-built TransactionData (BCS) bytes with the ephemeral key and
   * submit via /api/zklogin/execute. Use this for swap / NAVI / batch / send
   * PTBs that the server constructs in other endpoints.
   */
  const signAndExecuteBytes = useCallback(async (txBytesB64: string): Promise<string> => {
    const eph = loadEphemeral()
    if (!eph) throw new Error('No ephemeral session — sign in again.')

    const userSignature = await signTxBytes(eph, fromBase64(txBytesB64))

    const res = await fetch('/api/zklogin/execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        txBytesB64,
        userSignature,
        ephemeralPubKeyB64: eph.publicKeyB64,
        maxEpoch:           eph.maxEpoch,
        randomness:         eph.randomness,
      }),
    }).then(r => r.json())

    if (!res.digest) throw new Error(res.detail ?? res.error ?? 'execute failed')
    return res.digest as string
  }, [])

  return { user, loading, signIn, signOut, send, signAndExecuteBytes, refresh }
}
