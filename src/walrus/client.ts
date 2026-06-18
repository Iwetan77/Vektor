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
  throw new Error(`Walrus write failed after 3 attempts: ${String(lastError)}`)
}

/**
 * Look up blobId from registry, fetch bytes from Walrus, parse as JSON.
 * Returns null if no blob has been written yet for this wallet/key pair.
 */
export async function readUserData(
  userAddress: string,
  key: string,
): Promise<unknown | null> {
  const registry = loadRegistry()
  const blobId   = registry[userAddress]?.[key]
  if (!blobId) return null

  const bytes = await getWalrus().readBlob({ blobId })
  return JSON.parse(new TextDecoder().decode(bytes))
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
