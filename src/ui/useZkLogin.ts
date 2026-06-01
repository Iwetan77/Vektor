/**
 * useZkLogin — full zkLogin lifecycle hook.
 *
 * Flow:
 *  1. User clicks "Sign in with Google"
 *  2. `login()` generates an OAuth URL, saves ephemeral state to sessionStorage,
 *     then redirects to Google.
 *  3. Google redirects back to the app with an id_token in the URL hash.
 *  4. On mount, this hook detects the hash, restores ephemeral state,
 *     fetches a ZK proof from the Mysten prover, and stores the session.
 *  5. `session.address` is the user's deterministic Sui address — pass it
 *     as `senderAddress` to /api/intent just like a regular wallet address.
 */

import { useState, useEffect, useCallback } from 'react'
import { Ed25519Keypair }  from '@mysten/sui/keypairs/ed25519'
import { ZkLoginAuth }     from '../auth/zklogin.js'
import type { ZkLoginSession, ZkProof } from '../types.js'

// ─── Config ───────────────────────────────────────────────────────────────────

const CLIENT_ID    = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string | undefined
const NETWORK      = 'mainnet' as const
const REDIRECT_URI = typeof window !== 'undefined' ? window.location.origin : ''
const SALT_SERVICE = 'https://salt.api.mystenlabs.com/get_salt'

const SS_STATE   = 'vektor_zk_state'    // sessionStorage key for ephemeral state
const SS_SESSION = 'vektor_zk_session'  // sessionStorage key for persisted session

// ─── Serialisable session (persisted in sessionStorage) ───────────────────────

interface StoredSession {
  privKey:    string   // Bech32-encoded private key (from Ed25519Keypair.getSecretKey())
  jwt:        string
  nonce:      string
  address:    string
  proof:      ZkProof
  maxEpoch:   number
  randomness: string
}

function storeSession(s: ZkLoginSession, randomness: string): void {
  const stored: StoredSession = {
    privKey:    s.ephemeralKeypair.getSecretKey(),
    jwt:        s.jwt,
    nonce:      s.nonce,
    address:    s.address,
    proof:      s.proof,
    maxEpoch:   s.maxEpoch,
    randomness,
  }
  sessionStorage.setItem(SS_SESSION, JSON.stringify(stored))
}

function loadSession(): ZkLoginSession | null {
  try {
    const raw = sessionStorage.getItem(SS_SESSION)
    if (!raw) return null
    const s: StoredSession = JSON.parse(raw)
    return {
      ephemeralKeypair: Ed25519Keypair.fromSecretKey(s.privKey as any),
      jwt:      s.jwt,
      nonce:    s.nonce,
      address:  s.address,
      proof:    s.proof,
      maxEpoch: s.maxEpoch,
    }
  } catch {
    return null
  }
}

// ─── Salt helper ──────────────────────────────────────────────────────────────

async function fetchSalt(jwt: string): Promise<string> {
  try {
    const res  = await fetch(SALT_SERVICE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token: jwt }),
    })
    if (!res.ok) throw new Error('salt service error')
    const { salt } = await res.json() as { salt: string }
    return salt
  } catch {
    // Fallback: deterministic salt derived from a fixed value per session.
    // ⚠  In production, always use the Mysten salt service or your own
    //    persistent salt store so the user always gets the same Sui address.
    return BigInt(0).toString()
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface ZkLoginState {
  /** The active zkLogin session, or null if not signed in. */
  session:   ZkLoginSession | null
  /** True while the OAuth callback is being processed. */
  loading:   boolean
  /** Human-readable error message, or null. */
  error:     string | null
  /** True when VITE_GOOGLE_CLIENT_ID is configured. */
  available: boolean
  /** Redirect user to Google OAuth. */
  login:     () => Promise<void>
  /** Clear the session. */
  logout:    () => void
}

export function useZkLogin(): ZkLoginState {
  const [session,   setSession]   = useState<ZkLoginSession | null>(loadSession)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // ── Handle OAuth callback on mount ─────────────────────────────────────────
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.includes('id_token=')) return

    // Extract JWT from the hash fragment
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
    const jwt        = hashParams.get('id_token')
    if (!jwt) return

    // Clean the URL so a refresh doesn't re-trigger the callback
    window.history.replaceState({}, '', window.location.pathname + window.location.search)

    // Restore ephemeral state that was saved before the redirect
    const stateRaw = sessionStorage.getItem(SS_STATE)
    if (!stateRaw) {
      setError('Login state expired — please try again.')
      return
    }

    sessionStorage.removeItem(SS_STATE)
    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        const ephState = JSON.parse(stateRaw)
        const auth     = ZkLoginAuth.fromEphemeralState(NETWORK, {
          clientId:    CLIENT_ID ?? '',
          redirectUri: REDIRECT_URI,
          provider:    'google',
        }, ephState)

        const salt        = await fetchSalt(jwt)
        const zkSession   = await auth.handleCallback(jwt, salt)

        storeSession(zkSession, ephState.randomness)
        setSession(zkSession)
      } catch (e: any) {
        setError(e?.message ?? 'zkLogin failed — please try again.')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // ── login() — step 1: generate URL & redirect ──────────────────────────────
  const login = useCallback(async () => {
    if (!CLIENT_ID) {
      setError('VITE_GOOGLE_CLIENT_ID is not set. See .env.example for setup instructions.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const auth         = new ZkLoginAuth(NETWORK, {
        clientId:    CLIENT_ID,
        redirectUri: REDIRECT_URI,
        provider:    'google',
      })
      const { url }      = await auth.generateLoginUrl()
      const ephState     = auth.exportEphemeralState()
      sessionStorage.setItem(SS_STATE, JSON.stringify(ephState))
      window.location.href = url
    } catch (e: any) {
      setError(e?.message ?? 'Failed to generate login URL.')
      setLoading(false)
    }
  }, [])

  // ── logout() ───────────────────────────────────────────────────────────────
  const logout = useCallback(() => {
    sessionStorage.removeItem(SS_SESSION)
    sessionStorage.removeItem(SS_STATE)
    setSession(null)
    setError(null)
  }, [])

  return {
    session,
    loading,
    error,
    available: !!CLIENT_ID,
    login,
    logout,
  }
}
