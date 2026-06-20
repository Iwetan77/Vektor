/**
 * Walrus storage utility — writeUserData / readUserData.
 *
 * All user contact/group data is stored as Walrus blobs.
 * The server's SUI_PRIVATE_KEY funds every write (the app pays storage,
 * not the user).  A tiny local registry file maps wallet → {key → blobId}
 * so lookups are fast without on-chain queries.
 *
 * Retry policy: up to 3 attempts with exponential back-off before throwing.
 */

import type { WalrusClient }     from '@mysten/walrus'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Ed25519Keypair }        from '@mysten/sui/keypairs/ed25519'
import { KvBackedJson }          from '../db/kv.js'

/* ─── Network config ─────────────────────────────────────────────────────── */

const NETWORK: 'mainnet' | 'testnet' =
  (process.env.SUI_NETWORK as 'mainnet' | 'testnet') ?? 'mainnet'

const EPOCHS = 30  // ~30 Walrus epochs ≈ ~150 days on mainnet

/* ─── Singletons ────────────────────────────────────────────────────────── */

let _suiClient:   SuiClient     | null = null
let _walrus:      WalrusClient  | null = null
let _signer:      Ed25519Keypair | null = null

function getSuiClient(): SuiClient {
  if (!_suiClient) _suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK), network: NETWORK })
  return _suiClient
}

// Lazy dynamic import so @mysten/walrus (and its WASM blob) is only loaded when
// a contacts/Echo feature actually uses it — never on the sign-in or startup path.
async function getWalrus(): Promise<WalrusClient> {
  if (!_walrus) {
    const { WalrusClient } = await import('@mysten/walrus')
    _walrus = new WalrusClient({ network: NETWORK, suiClient: getSuiClient() })
  }
  return _walrus
}

function getSigner(): Ed25519Keypair {
  if (!_signer) {
    const pk = process.env.SUI_PRIVATE_KEY
    if (!pk) throw new Error('SUI_PRIVATE_KEY not set — cannot write to Walrus')
    _signer = Ed25519Keypair.fromSecretKey(pk)
  }
  return _signer
}

/* ─── Local blobId registry ──────────────────────────────────────────────── */
// Maps walletAddress → { dataKey → blobId }
// Only tiny blobId strings (~60 chars) live here.  All real data is in Walrus.

// Durable, cold-start-safe (Upstash KV when configured, else /tmp). Without this
// the wallet→blobId index is lost on every Vercel cold start, so a saved contact
// becomes unreadable on the next request ("no address saved for …").
type Registry = Record<string, Record<string, string>>

const _registry = new KvBackedJson<Registry>('vektor:walrus-registry', () => ({}))

function loadRegistry(): Registry {
  return _registry.get()
}

function saveRegistry(r: Registry): void {
  _registry.set(r)
}

/* ─── Local data cache (source of truth) ─────────────────────────────────── */
// Walrus mainnet writes fund storage from SUI_PRIVATE_KEY and can fail (no WAL
// balance, node flakiness, slow certification). We must never lose a user's
// contact / echo-rule edit to a storage hiccup, so the authoritative copy is a
// local JSON file written synchronously; Walrus is a best-effort durable backup.
// Maps walletAddress → { dataKey → JSON value }.

type DataStore = Record<string, Record<string, unknown>>

const _dataStore = new KvBackedJson<DataStore>('vektor:walrus-data', () => ({}))

function loadDataStore(): DataStore {
  return _dataStore.get()
}

function saveDataStore(s: DataStore): void {
  _dataStore.set(s)
}

function localGet(userAddress: string, key: string): unknown | undefined {
  return loadDataStore()[userAddress]?.[key]
}

function localPut(userAddress: string, key: string, data: unknown): void {
  const store = loadDataStore()
  store[userAddress]    ??= {}
  store[userAddress][key] = data
  saveDataStore(store)
}

/** Hydrate the durable Walrus index + data cache (call before contact reads). */
export async function syncWalrusFromKV(force = false): Promise<void> {
  await Promise.all([_registry.hydrate(force), _dataStore.hydrate(force)])
}

/* ─── Public API ──────────────────────────────────────────────────────────── */

/**
 * Serialize `data` to JSON, write to Walrus, return the blobId.
 * Retries up to 3 times before throwing.  Registry updated on success.
 */
export async function writeUserData(
  userAddress: string,
  key: string,
  data: unknown,
): Promise<string> {
  // 0. Pull current durable state so we merge onto the latest, not a stale copy.
  await syncWalrusFromKV()

  // 1. Authoritative local write — synchronous and reliable. This is what
  //    every subsequent read returns, so the user's edit is never lost even if
  //    Walrus is unreachable or the funding wallet has no WAL.
  localPut(userAddress, key, data)

  // 2. Best-effort durable backup to Walrus. Failures are logged, not thrown —
  //    the data is already safe locally.
  const blob = new TextEncoder().encode(JSON.stringify(data))
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1_000 * attempt))
    try {
      const { blobId } = await (await getWalrus()).writeBlob({
        blob,
        signer:    getSigner(),
        epochs:    EPOCHS,
        deletable: true,
      })

      // Persist blobId reference
      const registry = loadRegistry()
      registry[userAddress]        ??= {}
      registry[userAddress][key]     = blobId
      saveRegistry(registry)

      return blobId
    } catch (err) {
      lastError = err
    }
  }
  console.warn(`[walrus] backup write failed for ${key} (data saved locally): ${String(lastError).slice(0, 200)}`)
  return `local-${Date.now()}`
}

/**
 * Look up blobId from registry, fetch bytes from Walrus, parse as JSON.
 * Returns null if no blob has been written yet for this wallet/key pair.
 */
export async function readUserData(
  userAddress: string,
  key: string,
): Promise<unknown | null> {
  // 0. Pull current durable state (KV) so a cold instance sees prior writes.
  await syncWalrusFromKV()

  // 1. Local cache is authoritative and fast.
  const local = localGet(userAddress, key)
  if (local !== undefined) return local

  // 2. Fall back to Walrus (e.g. fresh server whose local cache was wiped but
  //    a durable backup exists). Hydrate the local cache on success.
  const registry = loadRegistry()
  const blobId   = registry[userAddress]?.[key]
  if (!blobId) return null

  try {
    const bytes = await (await getWalrus()).readBlob({ blobId })
    const data  = JSON.parse(new TextDecoder().decode(bytes))
    localPut(userAddress, key, data)
    return data
  } catch {
    return null
  }
}

/**
 * Return the stored blobId for (wallet, key), or null if not yet written.
 */
export function getBlobId(userAddress: string, key: string): string | null {
  return loadRegistry()[userAddress]?.[key] ?? null
}

/**
 * Check whether Walrus is operational (cost query succeeds).
 * Returns true on success, false on failure.
 */
export async function walrusHealthCheck(): Promise<boolean> {
  try {
    await (await getWalrus()).storageCost(32, 1)
    return true
  } catch {
    return false
  }
}
