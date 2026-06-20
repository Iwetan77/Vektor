/**
 * Per-device intent history (localStorage).
 *
 * The server stores history in per-instance memory + /tmp, which Vercel wipes on
 * cold starts and never shares across lambda instances — so server history reads
 * are unreliable. For beta we keep an authoritative copy in the user's browser,
 * keyed by wallet address. Each device sees its own actions, persisted across
 * sessions.
 */

export interface IntentRecord {
  id:        string
  type:      string
  summary:   string
  status:    'success' | 'pending' | 'failed'
  timestamp: string
}

const KEY = (wallet: string) => `vektor:history:${wallet.toLowerCase()}`
const MAX = 100

/** Fired on any history mutation so open views can refresh live. */
export const HISTORY_EVENT = 'vektor:history-changed'

export function loadHistory(wallet: string): IntentRecord[] {
  if (!wallet) return []
  try {
    const raw = localStorage.getItem(KEY(wallet))
    return raw ? (JSON.parse(raw) as IntentRecord[]) : []
  } catch {
    return []
  }
}

function persist(wallet: string, list: IntentRecord[]): void {
  try { localStorage.setItem(KEY(wallet), JSON.stringify(list.slice(0, MAX))) } catch { /* quota / private mode */ }
  try { window.dispatchEvent(new CustomEvent(HISTORY_EVENT)) } catch { /* SSR guard */ }
}

/** Add a record (most-recent first). De-duped by id so re-renders don't double-log. */
export function recordHistory(
  wallet: string,
  rec: { id?: string; type: string; summary: string; status: IntentRecord['status'] },
): string {
  const id = rec.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (!wallet) return id
  const list = loadHistory(wallet)
  if (list.some(r => r.id === id)) return id
  list.unshift({ id, type: rec.type, summary: rec.summary, status: rec.status, timestamp: new Date().toISOString() })
  persist(wallet, list)
  return id
}

export function updateHistoryStatus(wallet: string, id: string, status: IntentRecord['status']): void {
  if (!wallet || !id) return
  const list = loadHistory(wallet)
  const i = list.findIndex(r => r.id === id)
  if (i === -1) return
  list[i] = { ...list[i], status }
  persist(wallet, list)
}
