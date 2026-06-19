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

import { WalrusClient }          from '@mysten/walrus'
import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from '@mysten/sui/jsonRpc'
import { Ed25519Keypair }        from '@mysten/sui/keypairs/ed25519'
import fs   from 'fs'
import path from 'path'

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

function getWalrus(): WalrusClient {
  if (!_walrus) _walrus = new WalrusClient({ network: NETWORK, suiClient: getSuiClient() })
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

const REGISTRY_FILE = path.resolve(process.cwd(), 'data/walrus-registry.json')
type Registry = Record<string, Record<string, string>>

function loadRegistry(): Registry {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return {}
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) as Registry
  } catch {
    return {}
  }
}

function saveRegistry(r: Registry): void {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true })
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2))
}

/* ─── Local data cache (source of truth) ─────────────────────────────────── */
// Walrus mainnet writes fund storage from SUI_PRIVATE_KEY and can fail (no WAL
// balance, node flakiness, slow certification). We must never lose a user's
// contact / echo-rule edit to a storage hiccup, so the authoritative copy is a
// local JSON file written synchronously; Walrus is a best-effort durable backup.
// Maps walletAddress → { dataKey → JSON value }.

const DATA_FILE = path.resolve(process.cwd(), 'data/walrus-data.json')
type DataStore = Record<string, Record<string, unknown>>

function loadDataStore(): DataStore {
  try {
    if (!fs.existsSync(DATA_FILE)) return {}
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as DataStore
  } catch {
    return {}
  }
}

function saveDataStore(s: DataStore): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  fs.writeFileSync(DATA_FILE, JSON.stringify(s))
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
      const { blobId } = await getWalrus().writeBlob({
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
  // 1. Local cache is authoritative and fast.
  const local = localGet(userAddress, key)
  if (local !== undefined) return local

  // 2. Fall back to Walrus (e.g. fresh server whose local cache was wiped but
  //    a durable backup exists). Hydrate the local cache on success.
  const registry = loadRegistry()
  const blobId   = registry[userAddress]?.[key]
  if (!blobId) return null

  try {
    const bytes = await getWalrus().readBlob({ blobId })
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
    await getWalrus().storageCost(32, 1)
    return true
  } catch {
    return false
  }
}
