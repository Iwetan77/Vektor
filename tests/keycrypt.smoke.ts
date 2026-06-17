/**
 * Keycrypt smoke — verifies AES-256-GCM round-trip + plaintext absence +
 * fail-closed on missing VEKTOR_KEY_ENCRYPTION_SECRET.
 *
 * We bypass Walrus by exercising the exported encryptSecret/decryptSecret
 * helpers directly through an in-memory store that mirrors the Walrus
 * write/read shape (the same EncryptedBlob is what storeSessionKey sends to
 * writeUserData).
 */

import crypto from 'node:crypto'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'

async function main() {
  // Fresh module instance with no secret set → assert throw-on-unset
  delete process.env.VEKTOR_KEY_ENCRYPTION_SECRET
  const mod = await import('../src/echo/session.js')

  let threw = false
  try {
    mod.encryptSecret(Buffer.from('test'))
  } catch (err) {
    threw = err instanceof Error && /VEKTOR_KEY_ENCRYPTION_SECRET/.test(err.message)
  }
  console.log(`throw-on-unset → ${threw ? 'PASS' : 'FAIL'}`)
  if (!threw) process.exit(1)

  // Set the secret and round-trip a fresh keypair
  process.env.VEKTOR_KEY_ENCRYPTION_SECRET = crypto.randomBytes(32).toString('base64')

  const kp = new Ed25519Keypair()
  const rawSecret = kp.getSecretKey()
  const secretBuf = rawSecret instanceof Uint8Array
    ? Buffer.from(rawSecret)
    : Buffer.from(decodeSuiPrivateKey(rawSecret).secretKey)
  const originalAddress = kp.getPublicKey().toSuiAddress()
  const originalB64 = secretBuf.toString('base64')

  const blob = mod.encryptSecret(secretBuf)
  const stored = JSON.stringify(blob)

  // Plaintext absence
  const noPlaintext = !stored.includes(originalB64)
  console.log(`plaintext-absent → ${noPlaintext ? 'PASS' : 'FAIL'}`)
  if (!noPlaintext) process.exit(1)

  // Round-trip
  const recoveredBytes = mod.decryptSecret(blob)
  const recovered = Ed25519Keypair.fromSecretKey(recoveredBytes)
  const recoveredAddress = recovered.getPublicKey().toSuiAddress()
  const roundTripOk = recoveredAddress === originalAddress
  console.log(`round-trip → ${roundTripOk ? 'PASS' : 'FAIL'}`)
  if (!roundTripOk) process.exit(1)

  console.log('KEYCRYPT SMOKE OK')
}

main().catch(err => { console.error(err); process.exit(1) })
