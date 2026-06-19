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

/**
 * EPH key lives in localStorage (not sessionStorage) so it survives:
 *   - tab close / reopen
 *   - new tabs on the same browser (cookies are shared, so the server
 *     session cookie persists across tabs — the ephemeral key must too,
 *     otherwise the server says "signed in" but the browser can't sign).
 *
 * Trade-off: the key sits at rest in localStorage. That's fine because the
 * key already self-expires at maxEpoch (~2 epochs ≈ 48h) regardless of
 * storage, and the JWT/salt that turn this key into spendable signatures
 * live in an httpOnly cookie that JS can't read.
 */
const EPH_KEY = 'vektor.zk.ephemeral'

function loadEphemeral(): EphemeralSession | null {
  try { return JSON.parse(localStorage.getItem(EPH_KEY) ?? 'null') }
  catch { return null }
}
function saveEphemeral(s: EphemeralSession): void {
  localStorage.setItem(EPH_KEY, JSON.stringify(s))
}
function clearEphemeral(): void {
  try { localStorage.removeItem(EPH_KEY) } catch {}
  // Defensive: also wipe the old sessionStorage slot from previous builds.
  try { sessionStorage.removeItem(EPH_KEY) } catch {}
}

/** True if an ephemeral session exists AND has not yet hit its maxEpoch. */
function ephemeralIsLive(currentEpoch: number): boolean {
  const eph = loadEphemeral()
  if (!eph) return false
  return Number.isFinite(eph.maxEpoch) && eph.maxEpoch >= currentEpoch
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
      if (!r.signedIn) { setUser(null); return }

      // Server says signed-in. Verify the browser actually still has a usable
      // ephemeral key — if not (new tab, cleared storage, expired epoch), the
      // server session is dead weight and we have to drop it so the UI shows
      // the landing page instead of silently failing on the first signature.
      const eph = loadEphemeral()
      const epochR = await fetch('/api/zklogin/epoch').then(r => r.json()).catch(() => ({ epoch: 0 }))
      const currentEpoch = Number(epochR.epoch ?? 0)
      const live = eph && Number.isFinite(eph.maxEpoch) && eph.maxEpoch >= currentEpoch

      if (!live) {
        clearEphemeral()
        await fetch('/api/zklogin/logout', { method: 'POST' }).catch(() => {})
        setUser(null)
        return
      }

      setUser({
        address:   r.address,
        email:     r.email,
        name:      r.name,
        givenName: r.givenName ?? (r.name ? String(r.name).split(' ')[0] : null),
        picture:   r.picture ?? null,
      })
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

  /**
   * Throws with code NEED_RESIGN if the ephemeral key is missing or its
   * maxEpoch has passed. App.tsx catches this and re-launches signIn() so
   * the user gets bounced through Google again (usually silent) and the
   * page returns with a fresh key — no manual "sign in again" click needed.
   */
  const requireLiveEphemeral = useCallback(async (): Promise<EphemeralSession> => {
    const eph = loadEphemeral()
    let live  = !!eph
    if (eph) {
      try {
        const { epoch } = await fetch('/api/zklogin/epoch').then(r => r.json())
        live = Number.isFinite(eph.maxEpoch) && eph.maxEpoch >= Number(epoch)
      } catch { /* assume live on epoch fetch failure */ }
    }
    if (!eph || !live) {
      // Clean up the dead server session, then bounce to Google. The user
      // never has to click "sign in again" — Google's already authenticated
      // them, so this is a silent round-trip back into Vektor with a fresh key.
      clearEphemeral()
      try { await fetch('/api/zklogin/logout', { method: 'POST' }) } catch {}
      try {
        const { epoch } = await fetch('/api/zklogin/epoch').then(r => r.json())
        const fresh     = createEphemeralSession(Number(epoch))
        saveEphemeral(fresh)
        window.location.href = `/api/zklogin/login?nonce=${encodeURIComponent(fresh.nonce)}`
      } catch { /* swallow — fall through to throw below */ }
      const e = new Error('Your sign-in session expired — re-launching Google sign-in…') as Error & { code?: string }
      e.code = 'NEED_RESIGN'
      throw e
    }
    return eph
  }, [])

  const signOut = useCallback(async () => {
    clearEphemeral()
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
      const eph = await requireLiveEphemeral()

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
    [requireLiveEphemeral],
  )

  /**
   * Sign already-built TransactionData (BCS) bytes with the ephemeral key and
   * submit via /api/zklogin/execute. Use this for swap / NAVI / batch / send
   * PTBs that the server constructs in other endpoints.
   */
  const signAndExecuteBytes = useCallback(async (txBytesB64: string): Promise<string> => {
    const eph = await requireLiveEphemeral()

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
  }, [requireLiveEphemeral])

  return { user, loading, signIn, signOut, send, signAndExecuteBytes, refresh }
}

/** Type guard for the auto-resign error code thrown by send / signAndExecuteBytes. */
export function isNeedResign(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'NEED_RESIGN'
}
