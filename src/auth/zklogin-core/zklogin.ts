/**
 * zkLogin core — ephemeral keys, nonce, address derivation, signature assembly.
 *
 * EPHEMERAL keypair + nonce  → generated in the BROWSER. Private key never
 * leaves the device (sessionStorage). Server only ever sees the public key
 * and the user's signature over txBytes.
 * Address seed + signature   → assembled on the SERVER, where JWT, salt, and
 * Shinami proof live.
 *
 * Ported from sucker-punch — unchanged crypto logic, NodeNext-style imports.
 */

import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  genAddressSeed,
  getZkLoginSignature,
  jwtToAddress,
} from '@mysten/sui/zklogin'
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519'
import { fromBase64 } from '@mysten/sui/utils'

// ─── Ephemeral session (BROWSER) ──────────────────────────────────────────

export interface EphemeralSession {
  /** `suiprivkey1…` bech32. Browser-only — must never reach the server. */
  secretKey:    string
  /** Base64 of the ephemeral Ed25519 public key. Safe to send to the server. */
  publicKeyB64: string
  randomness:   string
  maxEpoch:     number
  nonce:        string
}

export function createEphemeralSession(
  currentEpoch: number,
  epochsValid = 2,
): EphemeralSession {
  const keypair    = new Ed25519Keypair()
  const randomness = generateRandomness()
  const maxEpoch   = currentEpoch + epochsValid
  const publicKey  = keypair.getPublicKey()
  const nonce      = generateNonce(publicKey, maxEpoch, randomness)

  return {
    secretKey:    keypair.getSecretKey(),
    publicKeyB64: publicKey.toBase64(),
    randomness,
    maxEpoch,
    nonce,
  }
}

export function ephemeralKeypair(session: EphemeralSession): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(session.secretKey)
}

/** Sign txBytes with the ephemeral key (BROWSER). */
export async function signTxBytes(
  session: EphemeralSession,
  txBytes: Uint8Array,
): Promise<string> {
  const { signature } = await ephemeralKeypair(session).signTransaction(txBytes)
  return signature
}

// ─── Address derivation ────────────────────────────────────────────────────

export function deriveAddress(jwt: string, salt: string): string {
  return jwtToAddress(jwt, salt, false)
}

export function addressSeed(opts: {
  salt: string
  sub:  string
  aud:  string
  keyClaimName?: string
}): string {
  return genAddressSeed(
    BigInt(opts.salt),
    opts.keyClaimName ?? 'sub',
    opts.sub,
    opts.aud,
  ).toString()
}

export function extendedEphemeralPublicKey(publicKeyB64: string): string {
  const pub = new Ed25519PublicKey(fromBase64(publicKeyB64))
  return getExtendedEphemeralPublicKey(pub)
}

// ─── Signature assembly (SERVER) ──────────────────────────────────────────

export interface ZkProof {
  proofPoints:      { a: string[]; b: string[][]; c: string[] }
  issBase64Details: { value: string; indexMod4: number }
  headerBase64:     string
  addressSeed:      string
}

export function assembleSignature(opts: {
  proof:         ZkProof
  maxEpoch:      number
  userSignature: string
}): string {
  return getZkLoginSignature({
    inputs:        opts.proof,
    maxEpoch:      opts.maxEpoch,
    userSignature: opts.userSignature,
  })
}
