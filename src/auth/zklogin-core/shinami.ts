/**
 * Shinami zkLogin wrappers — salt/address + proof generation (SERVER ONLY).
 *
 * • shinami_zkw_getOrCreateZkLoginWallet(jwt)       → { address, salt }
 * • shinami_zkp_createZkLoginProof(...args)         → { zkProof }
 *
 * Get a key at https://app.shinami.com (zkLogin Wallet + zkProver services).
 */

import type { ZkProof } from './zklogin.js'

const WALLET_URL = 'https://api.us1.shinami.com/sui/zkwallet/v1'
const PROVER_URL = 'https://api.us1.shinami.com/sui/zkprover/v1'

function apiKey(): string {
  const k = process.env.SHINAMI_API_KEY
  if (!k) {
    throw new Error('SHINAMI_API_KEY missing. Get one at https://app.shinami.com and set it in .env')
  }
  return k
}

type RpcResp<T> =
  | { jsonrpc: '2.0'; id: number; result: T }
  | { jsonrpc: '2.0'; id: number; error: { code: number; message: string } }

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey() },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!r.ok) {
    throw new Error(`shinami ${method} ${r.status}: ${(await r.text()).slice(0, 240)}`)
  }
  const j = (await r.json()) as RpcResp<T>
  if ('error' in j) throw new Error(`shinami ${method}: ${j.error.message} (${j.error.code})`)
  return j.result
}

/** Shinami returns salt base64-encoded over JSON-RPC; we need a decimal string. */
function decodeSalt(salt: string): string {
  if (/^\d+$/.test(salt)) return salt
  return BigInt('0x' + Buffer.from(salt, 'base64').toString('hex')).toString()
}

type ShinamiWallet = { salt: string; address: string }

export async function getZkLoginWallet(
  jwt: string,
): Promise<{ address: string; salt: string }> {
  const w = await rpc<ShinamiWallet>(WALLET_URL, 'shinami_zkw_getOrCreateZkLoginWallet', [jwt])
  return { address: w.address, salt: decodeSalt(w.salt) }
}

export async function createZkLoginProof(opts: {
  jwt:                        string
  maxEpoch:                   number
  extendedEphemeralPublicKey: string
  jwtRandomness:              string
  salt:                       string
  keyClaimName?:              string
}): Promise<Omit<ZkProof, 'addressSeed'>> {
  const { zkProof } = await rpc<{ zkProof: Omit<ZkProof, 'addressSeed'> }>(
    PROVER_URL,
    'shinami_zkp_createZkLoginProof',
    [
      opts.jwt,
      String(opts.maxEpoch),
      opts.extendedEphemeralPublicKey,
      opts.jwtRandomness,
      opts.salt,
      opts.keyClaimName ?? 'sub',
    ],
  )
  return zkProof
}
