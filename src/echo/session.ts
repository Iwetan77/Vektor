/**
 * Session key utilities — server-side helpers for Echo session authorization.
 * The session private key is stored on Walrus (keyed under 'echo-session-key').
 * The on-chain SessionAuthorization object is created by the frontend
 * (signed by the user's main wallet), then its objectId is stored in EchoUserData.
 */

import { Ed25519Keypair }   from '@mysten/sui/keypairs/ed25519'
import { Transaction }      from '@mysten/sui/transactions'
import crypto               from 'node:crypto'
import { writeUserData, readUserData } from '../walrus/client.js'

const SESSION_KEY = 'echo-session-key'
const ENC_ENV     = 'VEKTOR_KEY_ENCRYPTION_SECRET'

/* ─── AES-256-GCM helpers ─────────────────────────────────────────────── */

function loadEncryptionKey(): Buffer {
  const b64 = process.env[ENC_ENV]
  if (!b64) throw new Error(`${ENC_ENV} not set — refusing to store session key`)
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) {
    throw new Error(`${ENC_ENV} must be 32 bytes (base64-encoded), got ${key.length}`)
  }
  return key
}

interface EncryptedBlob { iv: string; ciphertext: string; tag: string; v: 1 }

export function encryptSecret(plaintext: Buffer): EncryptedBlob {
  const key    = loadEncryptionKey()
  const iv     = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct     = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag    = cipher.getAuthTag()
  return {
    v:          1,
    iv:         iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    tag:        tag.toString('base64'),
  }
}

export function decryptSecret(blob: EncryptedBlob): Buffer {
  const key      = loadEncryptionKey()
  const iv       = Buffer.from(blob.iv, 'base64')
  const ct       = Buffer.from(blob.ciphertext, 'base64')
  const tag      = Buffer.from(blob.tag, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/* ─── Session limits (USDC base units, 6 decimals) ────────────────────── */
// Single tier — Echo is one mode now. Caller can override at session-key create.
export const DEFAULT_LIMITS = {
  maxPerTx:  10_000_000_000n,   // $10k
  maxPerDay: 50_000_000_000n,   // $50k
} as const

/* ─── Generate a new ephemeral session keypair ─────────────────────────── */
export function generateSessionKeypair(): Ed25519Keypair {
  return new Ed25519Keypair()
}

/* ─── Store the session private key on Walrus (AES-256-GCM encrypted) ──── */
export async function storeSessionKey(
  wallet:     string,
  secretKey:  Uint8Array,
): Promise<string> {
  // Encrypt before writing — VEKTOR_KEY_ENCRYPTION_SECRET must be set.
  // Fails closed if the env var is missing so we never write plaintext.
  const blob = encryptSecret(Buffer.from(secretKey))
  return writeUserData(wallet, SESSION_KEY, blob)
}

/* ─── Load the session keypair from Walrus ────────────────────────────── */
export async function loadSessionKeypair(
  wallet: string,
): Promise<Ed25519Keypair | null> {
  try {
    const raw = await readUserData(wallet, SESSION_KEY) as
      | EncryptedBlob
      | { key: string }
      | null
    if (!raw) return null

    // Backward-compat: handle legacy plaintext { key } payloads.
    if ('key' in raw && typeof raw.key === 'string') {
      return Ed25519Keypair.fromSecretKey(Buffer.from(raw.key, 'base64'))
    }

    if ('ciphertext' in raw && 'iv' in raw && 'tag' in raw) {
      const bytes = decryptSecret(raw as EncryptedBlob)
      return Ed25519Keypair.fromSecretKey(bytes)
    }

    return null
  } catch {
    return null
  }
}

/* ─── Build the SessionAuthorization PTB (to be signed by the main wallet) */
export async function buildSessionAuthPtb(opts: {
  packageId:    string
  sessionAddr:  string
  maxPerTx:     bigint
  maxPerDay:    bigint
  expiresAt:    number   // epoch ms
  clockId?:     string
}): Promise<string /* base64 PTB */> {
  const { packageId, sessionAddr, maxPerTx, maxPerDay, expiresAt, clockId = '0x6' } = opts

  const tx = new Transaction()
  tx.moveCall({
    target:    `${packageId}::session_auth::create_and_share`,
    arguments: [
      tx.pure.address(sessionAddr),
      tx.pure.u64(maxPerTx),
      tx.pure.u64(maxPerDay),
      tx.pure.vector('u8', []),   // all protocols allowed
      tx.pure.u64(BigInt(expiresAt)),
      tx.object(clockId),
    ],
  })

  const bytes = await tx.build({ client: undefined as any })
  return Buffer.from(bytes).toString('base64')
}

/* ─── Verify a session auth object on-chain ──────────────────────────────── */
export async function verifySessionAuth(
  authObjectId: string,
  suiClient:    any,
): Promise<{ valid: boolean; expiresAt: number; maxPerTx: bigint; maxPerDay: bigint } | null> {
  try {
    const obj = await suiClient.getObject({
      id:      authObjectId,
      options: { showContent: true },
    })
    const fields = (obj?.data?.content as any)?.fields
    if (!fields) return null
    return {
      valid:     !fields.is_revoked && Number(fields.expires_at) > Date.now(),
      expiresAt: Number(fields.expires_at),
      maxPerTx:  BigInt(fields.max_amount_per_tx),
      maxPerDay: BigInt(fields.max_amount_per_day),
    }
  } catch {
    return null
  }
}
