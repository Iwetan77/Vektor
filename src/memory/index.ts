/**
 * Per-wallet session memory.
 * Keyed to wallet address. Loaded into Claude system prompt on each new session.
 */

import fs             from 'fs'
import path           from 'path'
import { randomUUID } from 'crypto'

const MEMORY_DIR = process.env.VERCEL
  ? '/tmp/vektor-data/memory'
  : path.resolve(process.cwd(), 'data/memory')

export interface UserAlert {
  id:        string
  type:      'health_factor' | 'scheduled' | 'condition' | 'position' | 'yield' | 'general'
  message:   string
  severity:  'info' | 'warning' | 'critical'
  action?:   string   // intent text to send when user clicks "Execute"
  seen:      boolean
  createdAt: string
}

export interface IntentRecord {
  id:        string
  type:      string
  summary:   string
  status:    'success' | 'pending' | 'failed'
  timestamp: string
}

/**
 * A single recommendation Vektor has given. Lets the agent stay consistent with
 * its own past advice instead of contradicting itself across sessions.
 */
export interface AdviceEntry {
  id:             string
  wallet:         string
  ts:             string
  intentType:     string
  summary:        string   // what the user was trying to do
  recommendation: string   // the one-line advice Vektor gave
  riskScore:      number   // Guardian score at the time (0–100)
}

export interface UserMemory {
  wallet:              string
  lastSeen:            string
  preferredLanguage?:  string   // ISO 639-1 code — set after first detection, persisted across sessions
  preferences: {
    riskTolerance:     'low' | 'medium' | 'high'
    preferredProtocols: string[]
    typicalAmounts:    Record<string, number>
  }
  portfolioSnapshot?:     any
  conversationSummary?:   string
  naviHealthFactor?:      number
  pendingAlerts:          UserAlert[]
  intentHistory:          IntentRecord[]
  adviceLog:              AdviceEntry[]
  stats: {
    totalIntents:    number
    totalSwapVolume: number
    firstSeen:       string
  }
}

function memPath(wallet: string): string {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  return path.join(MEMORY_DIR, `${wallet.toLowerCase()}.json`)
}

export function getMemory(wallet: string): UserMemory {
  const p = memPath(wallet)
  if (!fs.existsSync(p)) {
    return {
      wallet,
      lastSeen:      new Date().toISOString(),
      preferences:   { riskTolerance: 'medium', preferredProtocols: [], typicalAmounts: {} },
      pendingAlerts: [],
      intentHistory: [],
      adviceLog:     [],
      stats:         { totalIntents: 0, totalSwapVolume: 0, firstSeen: new Date().toISOString() },
    }
  }
  const mem = JSON.parse(fs.readFileSync(p, 'utf8')) as UserMemory
  // backfill fields for existing wallets
  if (!mem.intentHistory) mem.intentHistory = []
  if (!mem.adviceLog)     mem.adviceLog     = []
  return mem
}

export function saveMemory(mem: UserMemory): void {
  mem.lastSeen = new Date().toISOString()
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
  fs.writeFileSync(memPath(mem.wallet), JSON.stringify(mem, null, 2))
}

export function updatePortfolioSnapshot(wallet: string, snapshot: any): void {
  const mem = getMemory(wallet)
  mem.portfolioSnapshot = snapshot
  saveMemory(mem)
}

export function updateHealthFactor(wallet: string, hf: number): void {
  const mem = getMemory(wallet)
  mem.naviHealthFactor = hf
  saveMemory(mem)
}

export function addAlert(wallet: string, alert: Omit<UserAlert, 'id' | 'seen' | 'createdAt'>): void {
  const mem = getMemory(wallet)
  mem.pendingAlerts.push({
    ...alert,
    id:        randomUUID(),
    seen:      false,
    createdAt: new Date().toISOString(),
  })
  saveMemory(mem)
}

export function markAlertsSeen(wallet: string): void {
  const mem = getMemory(wallet)
  mem.pendingAlerts = mem.pendingAlerts.map(a => ({ ...a, seen: true }))
  saveMemory(mem)
}

export function getUnseenAlerts(wallet: string): UserAlert[] {
  return getMemory(wallet).pendingAlerts.filter(a => !a.seen)
}

export function incrementIntentCount(wallet: string, swapAmountUsd = 0): void {
  const mem = getMemory(wallet)
  mem.stats.totalIntents++
  mem.stats.totalSwapVolume += swapAmountUsd
  saveMemory(mem)
}

export function logIntent(
  wallet: string,
  record: Omit<IntentRecord, 'id' | 'timestamp'>,
): string {
  const mem = getMemory(wallet)
  const id  = randomUUID()
  mem.intentHistory.unshift({
    ...record,
    id,
    timestamp: new Date().toISOString(),
  })
  // Keep last 50 intents
  mem.intentHistory = mem.intentHistory.slice(0, 50)
  saveMemory(mem)
  return id
}

/** Update the status of a previously logged intent (success/failed). No-op if not found. */
export function updateIntentStatus(
  wallet: string,
  id: string,
  status: IntentRecord['status'],
): void {
  const mem = getMemory(wallet)
  const rec = mem.intentHistory.find(r => r.id === id)
  if (!rec) return
  rec.status = status
  saveMemory(mem)
}

/** Append a recommendation to the advice log. Keeps the most recent 30. */
export function addAdvice(wallet: string, entry: Omit<AdviceEntry, 'id' | 'wallet' | 'ts'>): AdviceEntry {
  const mem = getMemory(wallet)
  const rec: AdviceEntry = { ...entry, id: randomUUID(), wallet, ts: new Date().toISOString() }
  mem.adviceLog.unshift(rec)
  mem.adviceLog = mem.adviceLog.slice(0, 30)
  saveMemory(mem)
  return rec
}

/** Recent advice entries, newest first. */
export function getAdvice(wallet: string, limit = 20): AdviceEntry[] {
  return getMemory(wallet).adviceLog.slice(0, limit)
}

/**
 * Get the user's preferred language (stored after first detection).
 * Returns 'en' if none stored.
 */
export function getPreferredLanguage(wallet: string): string {
  return getMemory(wallet).preferredLanguage ?? 'en'
}

/**
 * Persist the detected language for this user.
 * Only writes if the language changed — avoids unnecessary disk I/O.
 */
export function setPreferredLanguage(wallet: string, lang: string): void {
  if (!lang || lang === 'en') return   // 'en' is the default, no need to persist
  const mem = getMemory(wallet)
  if (mem.preferredLanguage === lang) return   // unchanged, skip write
  mem.preferredLanguage = lang
  saveMemory(mem)
}

/** Build a concise context string for the Claude system prompt. */
export function buildMemoryContext(wallet: string): string {
  const mem = getMemory(wallet)
  const lines: string[] = [`User wallet: ${wallet}`]

  if (mem.portfolioSnapshot?.totalUsd) {
    lines.push(`Portfolio value: $${mem.portfolioSnapshot.totalUsd.toFixed(2)}`)
    if (mem.portfolioSnapshot.balances?.length) {
      const top = mem.portfolioSnapshot.balances.slice(0, 5)
        .map((b: any) => `${b.symbol} ${b.formatted}`)
        .join(', ')
      lines.push(`Holdings: ${top}`)
    }
  }

  if (mem.naviHealthFactor) {
    lines.push(`NAVI health factor: ${mem.naviHealthFactor.toFixed(2)}`)
  }

  if (mem.preferences.riskTolerance !== 'medium') {
    lines.push(`Risk preference: ${mem.preferences.riskTolerance}`)
  }

  if (mem.stats.totalIntents > 0) {
    lines.push(`Total intents executed: ${mem.stats.totalIntents}`)
  }

  if (mem.conversationSummary) {
    lines.push(`Previous context: ${mem.conversationSummary}`)
  }

  return lines.join('\n')
}
