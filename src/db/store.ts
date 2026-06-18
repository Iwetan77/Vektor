/**
 * JSON file-based store for Vektor.
 * Persists scheduled intents, conditions, payment requests, and memecoin positions.
 * Drop-in Supabase swap: replace read/write with Supabase client calls.
 */

import fs   from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import type { ParsedIntent } from '../parser/types.js'

const DATA_FILE = path.resolve(process.cwd(), 'data/store.json')

/* ─── Types ─────────────────────────────────────────────────────────────── */

export interface ScheduledIntent {
  id:           string
  wallet:       string
  type:         'dca' | 'payment' | 'one-time'
  intent:       ParsedIntent
  amount:       number
  token:        string
  targetToken?: string
  recipient?:   string
  schedule: {
    frequency:   'daily' | 'weekly' | 'monthly' | 'once'
    dayOfWeek?:  string
    date?:       string
    totalRuns:   number
    completedRuns: number
    nextRun:     string   // ISO
  }
  active:     boolean
  createdAt:  string
}

export interface Condition {
  id:          string
  wallet:      string
  description: string
  trigger: {
    type:       'price_below' | 'price_above' | 'health_factor_below'
    asset:      string
    threshold:  number
    feedId?:    string
  }
  action:      ParsedIntent
  autoExecute: boolean
  fired:       boolean
  createdAt:   string
}

export interface PaymentRequest {
  id:            string
  creatorWallet: string
  token:         string
  amount:        number
  description?:  string
  status:        'pending' | 'paid'
  createdAt:     string
  paidAt?:       string
  paidBy?:       string
}

export interface InviteLink {
  token:         string
  creatorWallet: string
  createdAt:     string
  /** Number of times the invite URL has been opened. */
  uses:          number
  /** Funding amount in human units (e.g. 5 = $5 USDC). */
  amount:        number
  token_symbol:  string
  funded:        boolean
  claimed:       boolean
  claimedBy:     string | null
  claimDigest:   string | null
}

export interface MemePosition {
  id:            string
  wallet:        string
  token:         string
  entryAmountUsd: number
  entryPrice:    number
  profitTarget?: number
  stopLoss?:     number
  autoExit:      boolean
  status:        'open' | 'closed'
  openedAt:      string
  closedAt?:     string
  closedPnl?:    number
}

interface StoreData {
  scheduled:  ScheduledIntent[]
  conditions: Condition[]
  payments:   PaymentRequest[]
  positions:  MemePosition[]
  invites:    InviteLink[]
}

/* ─── I/O ───────────────────────────────────────────────────────────────── */

function load(): StoreData {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { scheduled: [], conditions: [], payments: [], positions: [], invites: [] }
    }
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as StoreData
    // Back-fill missing keys introduced in later versions
    if (!data.invites) data.invites = []
    return data
  } catch {
    return { scheduled: [], conditions: [], payments: [], positions: [], invites: [] }
  }
}

function save(data: StoreData): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

/* ─── Scheduled intents ──────────────────────────────────────────────────── */

export function addScheduled(item: Omit<ScheduledIntent, 'id' | 'createdAt'>): ScheduledIntent {
  const store = load()
  const record: ScheduledIntent = { ...item, id: uuid(), createdAt: new Date().toISOString() }
  store.scheduled.push(record)
  save(store)
  return record
}

export function getScheduled(wallet: string): ScheduledIntent[] {
  return load().scheduled.filter(s => s.wallet === wallet && s.active)
}

export function getAllScheduled(): ScheduledIntent[] {
  return load().scheduled.filter(s => s.active)
}

/** Find a scheduled intent by ID regardless of active/inactive status. */
export function getScheduledById(id: string): ScheduledIntent | undefined {
  return load().scheduled.find(s => s.id === id)
}

export function cancelScheduled(id: string): boolean {
  const store = load()
  const idx   = store.scheduled.findIndex(s => s.id === id)
  if (idx === -1) return false
  store.scheduled[idx].active = false
  save(store)
  return true
}

export function markScheduledRun(id: string, nextRun: string): void {
  const store = load()
  const item  = store.scheduled.find(s => s.id === id)
  if (!item) return
  item.schedule.completedRuns++
  item.schedule.nextRun = nextRun
  if (item.schedule.totalRuns > 0 && item.schedule.completedRuns >= item.schedule.totalRuns) {
    item.active = false
  }
  save(store)
}

/* ─── Conditions ─────────────────────────────────────────────────────────── */

export function addCondition(item: Omit<Condition, 'id' | 'createdAt' | 'fired'>): Condition {
  const store = load()
  const record: Condition = { ...item, id: uuid(), fired: false, createdAt: new Date().toISOString() }
  store.conditions.push(record)
  save(store)
  return record
}

export function getConditions(wallet: string): Condition[] {
  return load().conditions.filter(c => c.wallet === wallet && !c.fired)
}

export function getAllConditions(): Condition[] {
  return load().conditions.filter(c => !c.fired)
}

export function getConditionById(id: string): Condition | undefined {
  return load().conditions.find(c => c.id === id)
}

export function markConditionFired(id: string): void {
  const store = load()
  const item  = store.conditions.find(c => c.id === id)
  if (item) { item.fired = true; save(store) }
}

export function cancelCondition(id: string): boolean {
  const store = load()
  const idx   = store.conditions.findIndex(c => c.id === id)
  if (idx === -1) return false
  store.conditions[idx].fired = true
  save(store)
  return true
}

/* ─── Payment requests ───────────────────────────────────────────────────── */

export function createPayment(item: Omit<PaymentRequest, 'id' | 'createdAt' | 'status'>): PaymentRequest {
  const store = load()
  const record: PaymentRequest = { ...item, id: uuid(), status: 'pending', createdAt: new Date().toISOString() }
  store.payments.push(record)
  save(store)
  return record
}

export function getPayment(id: string): PaymentRequest | undefined {
  return load().payments.find(p => p.id === id)
}

export function markPaymentPaid(id: string, paidBy: string): void {
  const store = load()
  const item  = store.payments.find(p => p.id === id)
  if (item) { item.status = 'paid'; item.paidAt = new Date().toISOString(); item.paidBy = paidBy; save(store) }
}

/* ─── Memecoin positions ─────────────────────────────────────────────────── */

export function addPosition(item: Omit<MemePosition, 'id' | 'openedAt' | 'status'>): MemePosition {
  const store = load()
  const record: MemePosition = { ...item, id: uuid(), status: 'open', openedAt: new Date().toISOString() }
  store.positions.push(record)
  save(store)
  return record
}

export function getPositions(wallet: string): MemePosition[] {
  return load().positions.filter(p => p.wallet === wallet && p.status === 'open')
}

export function getAllOpenPositions(): MemePosition[] {
  return load().positions.filter(p => p.status === 'open')
}

export function closePosition(id: string, pnl: number): void {
  const store = load()
  const item  = store.positions.find(p => p.id === id)
  if (item) { item.status = 'closed'; item.closedAt = new Date().toISOString(); item.closedPnl = pnl; save(store) }
}

/* ─── Invite links ───────────────────────────────────────────────────────────── */

export function createInviteLink(
  creatorWallet: string,
  amount: number = 1,
  token_symbol: string = 'USDC',
): InviteLink {
  const store  = load()
  const record: InviteLink = {
    token: uuid(),
    creatorWallet,
    createdAt: new Date().toISOString(),
    uses: 0,
    amount,
    token_symbol,
    funded:      false,
    claimed:     false,
    claimedBy:   null,
    claimDigest: null,
  }
  store.invites.push(record)
  save(store)
  return record
}

export function markInviteClaimed(token: string, claimedBy: string, digest: string): void {
  const store = load()
  const item = store.invites.find(i => i.token === token)
  if (!item) return
  item.claimed = true
  item.claimedBy = claimedBy
  item.claimDigest = digest
  save(store)
}

export function getInviteLink(token: string): InviteLink | undefined {
  return load().invites.find(i => i.token === token)
}

/** Increment the use counter and return the updated record. */
export function touchInviteLink(token: string): InviteLink | undefined {
  const store = load()
  const item  = store.invites.find(i => i.token === token)
  if (!item) return undefined
  item.uses++
  save(store)
  return item
}
