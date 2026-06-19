/**
 * SuiNS resolver — maps human names (name.sui) to Sui addresses, and back.
 *
 * SuiNS names only resolve on MAINNET. If SUI_NETWORK=testnet the SuinsClient
 * is still constructed against a mainnet RPC so demos work regardless of the
 * app's primary network.
 */

import { SuinsClient } from '@mysten/suins'
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'

let _client: SuinsClient | null = null

function getClient(): SuinsClient {
  if (_client) return _client
  // SuiNS resolves on mainnet. Dedicated mainnet client regardless of SUI_NETWORK.
  const sui = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet'), network: 'mainnet' })
  _client = new SuinsClient({ client: sui as any, network: 'mainnet' })
  return _client
}

const forwardCache = new Map<string, { addr: string | null; ts: number }>()
const reverseCache = new Map<string, { name: string | null; ts: number }>()
const TTL_MS = 60_000

/** Normalize "@foo" → "foo.sui", lowercase, strip whitespace. */
function normalize(raw: string): string {
  let s = raw.trim().toLowerCase()
  if (s.startsWith('@')) s = s.slice(1) + '.sui'
  return s
}

/** True if a string looks like a SuiNS name (e.g. "adeniyi.sui", "@x"). */
export function isSuiName(s: string | null | undefined): boolean {
  if (!s) return false
  const n = normalize(s)
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sui$/i.test(n)
}

/** Resolve name.sui → 0x address. Returns null on miss. Cached 60s. */
export async function resolveSuiName(name: string): Promise<string | null> {
  if (!isSuiName(name)) return null
  const key = normalize(name)
  const hit = forwardCache.get(key)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.addr
  try {
    const rec  = await getClient().getNameRecord(key)
    // targetAddress may be empty string when the name is registered but no address is set.
    const addr = rec?.targetAddress
    const out  = addr && /^0x[0-9a-fA-F]+$/.test(addr) ? addr : null
    forwardCache.set(key, { addr: out, ts: Date.now() })
    return out
  } catch (err) {
    // Log so we can see RPC/SDK issues instead of silently returning null.
    console.warn('[suins] resolve failed for', key, '—', (err as any)?.message ?? err)
    forwardCache.set(key, { addr: null, ts: Date.now() })
    return null
  }
}

/** Reverse lookup: 0x address → name.sui (for display). Returns null on miss. */
export async function reverseSuiName(address: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) return null
  const key = address.toLowerCase()
  const hit = reverseCache.get(key)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.name
  try {
    // The new SDK doesn't ship a built-in reverse lookup; query the on-chain reverse registry.
    // For now, return null (callers tolerate it gracefully). The forward path is what matters.
    reverseCache.set(key, { name: null, ts: Date.now() })
    return null
  } catch {
    reverseCache.set(key, { name: null, ts: Date.now() })
    return null
  }
}

/** Exposed for tests. */
export function _normalizeSuiName(raw: string): string {
  return normalize(raw)
}
