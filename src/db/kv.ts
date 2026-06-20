/**
 * Durable coordination layer (web3-appropriate, not a database of record).
 *
 * On Vercel the filesystem is ephemeral (`/tmp` is wiped on cold starts and not
 * shared between lambda instances), so any state that must survive a cold start
 * or be visible to *another* instance — invite tokens, the Walrus blobId index,
 * Echo conditions/schedules — needs a shared store. Real user data still lives
 * on-chain / Walrus; this is only the tiny index + coordination state.
 *
 * Backend: Upstash Redis REST (or Vercel KV, which is Upstash under the hood).
 * Accessed over plain `fetch` so there's no SDK to bundle. If no KV env vars are
 * present, every helper degrades to a `/tmp` JSON file — i.e. exactly today's
 * behaviour — so local dev and un-provisioned deploys keep working unchanged.
 */

import fs   from 'fs'
import path from 'path'

const KV_URL =
  process.env.UPSTASH_REDIS_REST_URL ??
  process.env.KV_REST_API_URL ??
  ''
const KV_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ??
  process.env.KV_REST_API_TOKEN ??
  ''

export function kvEnabled(): boolean {
  return Boolean(KV_URL && KV_TOKEN)
}

/** Run a single Redis command over the Upstash REST API. Returns `result`. */
async function kvCommand(cmd: (string | number)[]): Promise<unknown> {
  const resp = await fetch(KV_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(cmd),
  })
  if (!resp.ok) throw new Error(`KV ${cmd[0]} failed: ${resp.status}`)
  const json = (await resp.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(`KV ${cmd[0]} error: ${json.error}`)
  return json.result
}

async function kvGetRaw(key: string): Promise<string | null> {
  const r = await kvCommand(['GET', key])
  return typeof r === 'string' ? r : null
}

async function kvSetRaw(key: string, value: string): Promise<void> {
  await kvCommand(['SET', key, value])
}

/* ─── /tmp fallback ───────────────────────────────────────────────────────── */

const DATA_DIR = process.env.VERCEL ? '/tmp/vektor-data' : path.resolve(process.cwd(), 'data')

function filePathFor(key: string): string {
  return path.join(DATA_DIR, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`)
}

function fileGet(key: string): string | null {
  try {
    const p = filePathFor(key)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  } catch { return null }
}

function fileSet(key: string, value: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(filePathFor(key), value)
  } catch { /* non-fatal */ }
}

/* ─── KvBackedJson — a sync working copy with durable async persistence ─────── */

/**
 * Holds a JSON value in memory for synchronous reads/writes (so existing
 * synchronous call sites don't have to change) and persists it durably.
 *
 *   • hydrate()  — pull the latest value from KV into the in-memory copy. Cheap:
 *                  re-fetches at most once per `ttlMs`. Call it before a request
 *                  reads state so a different lambda instance's writes are seen.
 *   • get()      — synchronous read of the in-memory copy.
 *   • set(v)     — synchronous in-memory update + fire-and-forget durable write
 *                  (KV when configured, else /tmp).
 *
 * Concurrency model is last-write-wins on the whole blob. That's acceptable for
 * the low-volume coordination state we keep here (beta scale); it is NOT meant
 * for high-contention financial records, which live on-chain.
 */
export class KvBackedJson<T> {
  private cache: T | null = null
  private lastHydrate = 0

  constructor(
    private readonly key: string,
    private readonly empty: () => T,
    private readonly ttlMs = 3_000,
  ) {}

  async hydrate(force = false): Promise<void> {
    if (!force && this.cache !== null && Date.now() - this.lastHydrate < this.ttlMs) return
    try {
      const raw = kvEnabled() ? await kvGetRaw(this.key) : fileGet(this.key)
      this.cache = raw ? (JSON.parse(raw) as T) : this.empty()
    } catch {
      if (this.cache === null) this.cache = this.empty()
    }
    this.lastHydrate = Date.now()
  }

  get(): T {
    if (this.cache === null) {
      // Synchronous cold read — best effort from /tmp; KV value arrives on next
      // hydrate(). Prevents a null return before the first async hydrate ran.
      const raw = fileGet(this.key)
      this.cache = raw ? (JSON.parse(raw) as T) : this.empty()
    }
    return this.cache
  }

  set(value: T): void {
    this.cache = value
    const raw = JSON.stringify(value)
    fileSet(this.key, raw)                 // synchronous local copy
    if (kvEnabled()) void kvSetRaw(this.key, raw).catch(() => { /* durable best-effort */ })
  }
}
