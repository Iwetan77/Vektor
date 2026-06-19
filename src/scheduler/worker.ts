/**
 * Scheduler worker — checks every minute for due scheduled intents.
 * When a DCA or one-time swap fires, execution is attempted in this order:
 *   1. A valid Echo session key → autonomous, cap-enforced on-chain (offline-friendly)
 *   2. SUI_PRIVATE_KEY (if set)  → server-side execute via Routex
 *   3. Neither                   → queue a one-tap Execute alert for the user
 */

import cron      from 'node-cron'
import { EventEmitter } from 'events'
import { getAllScheduled, markScheduledRun, type ScheduledIntent } from '../db/store.js'
import { addAlert } from '../memory/index.js'

export const schedulerEvents = new EventEmitter()

const TOKEN_DECIMALS: Record<string, number> = {
  SUI: 1e9, USDC: 1e6, USDT: 1e6, DEEP: 1e6, WETH: 1e8, WBTC: 1e8, BUCK: 1e9,
}

function nextRunAfter(intent: ScheduledIntent): string {
  const { frequency, dayOfWeek } = intent.schedule
  const now = new Date()

  if (frequency === 'daily') {
    const next = new Date(now)
    next.setDate(next.getDate() + 1)
    next.setHours(12, 0, 0, 0)
    return next.toISOString()
  }

  if (frequency === 'weekly') {
    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    }
    const targetDay = dayMap[dayOfWeek?.toLowerCase() ?? 'monday'] ?? 1
    const next      = new Date(now)
    const daysAhead = (targetDay + 7 - now.getDay()) % 7 || 7
    next.setDate(next.getDate() + daysAhead)
    next.setHours(12, 0, 0, 0)
    return next.toISOString()
  }

  if (frequency === 'monthly') {
    const next = new Date(now)
    next.setMonth(next.getMonth() + 1)
    next.setDate(1)
    next.setHours(12, 0, 0, 0)
    return next.toISOString()
  }

  // once — no next run
  return ''
}

/**
 * Preference (1): execute a due swap autonomously through the user's Echo
 * session key — the delegation mechanism that lets Vektor act while the user is
 * offline, WITHOUT any raw SUI_PRIVATE_KEY.
 *
 * We do NOT re-implement signing here. We route through the existing
 * /api/echo/:wallet/execute endpoint (worker-secret auth) so the on-chain
 * session_auth::record_execution cap check runs atomically with the swap. The
 * spend cap is therefore enforced on-chain, never bypassed: if the swap would
 * exceed it the transaction aborts, the endpoint returns an error, and we
 * return false so the caller falls through to the next tier (one-tap alert).
 *
 * Returns true only when the swap actually executed (and a success alert was
 * emitted); false means "couldn't / shouldn't — fall through".
 */
async function tryEchoSessionExecute(
  item: ScheduledIntent,
  fromToken: string,
  toToken: string,
  amount: number,
  label: string,
): Promise<boolean> {
  // Worker-secret auth must be available to self-call the execute endpoint.
  const workerSecret = process.env.ECHO_WORKER_SECRET
  if (!workerSecret) return false

  try {
    const [{ loadSessionKeypair }, { readEchoData }] = await Promise.all([
      import('../echo/session.js'),
      import('../echo/walrus.js'),
    ])

    // Gate strictly on: a usable session key exists AND its metadata is present
    // AND it hasn't expired. (The amount-vs-cap check is enforced on-chain by
    // the endpoint's record_execution call.)
    const keypair = await loadSessionKeypair(item.wallet)
    if (!keypair) return false
    const meta = (await readEchoData(item.wallet)).sessionKeyMetadata
    if (!meta || meta.expiresAt <= Date.now()) return false

    const port = process.env.PORT ?? '3001'
    const resp = await fetch(`http://127.0.0.1:${port}/api/echo/${item.wallet}/execute`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-echo-worker-secret': workerSecret },
      body:    JSON.stringify({ from: fromToken, to: toToken, amount }),
    })
    const json = await resp.json().catch(() => ({} as any))
    if (!resp.ok || !json?.digest) return false   // cap exceeded / quote failed / etc → fall through

    const digest = String(json.digest)
    addAlert(item.wallet, {
      type:     'scheduled',
      message:  `✓ ${label} executed via Echo session key: ${amount} ${fromToken} → ${toToken}. TX: ${digest.slice(0, 12)}…${digest.slice(-6)}`,
      severity: 'info',
    })
    schedulerEvents.emit('executed', { item, digest })
    return true
  } catch {
    return false
  }
}

/** Auto-execute a scheduled swap server-side using the stored keypair */
async function tryAutoExecute(item: ScheduledIntent): Promise<void> {
  const privateKey = process.env.SUI_PRIVATE_KEY
  const label      = item.type === 'dca' ? 'DCA' : 'Scheduled swap'
  const fromToken  = item.token.toUpperCase()
  // Prefer explicit targetToken, then fall back to the stored intent's output_goal
  const toToken    = (item.targetToken ?? item.intent?.output_goal ?? 'USDC').toUpperCase()
  const amount     = item.amount

  // Bail out silently for ghost records (informational intents stored by mistake)
  if (!amount || amount <= 0 || !fromToken) {
    addAlert(item.wallet, {
      type:     'scheduled',
      message:  `Skipped malformed scheduled entry (no amount/token). ID: ${item.id.slice(0, 8)}`,
      severity: 'info',
    })
    return
  }

  // Preference (1): autonomous execution via the user's Echo session key.
  // Falls through (returns false) if no key / expired / over cap / not configured.
  if (await tryEchoSessionExecute(item, fromToken, toToken, amount, label)) return

  if (!privateKey) {
    // Preference (3): no server key and no session key — send an actionable alert
    // carrying the schedule ID so the UI can call /api/execute-scheduled/:id.
    addAlert(item.wallet, {
      type:     'scheduled',
      message:  `⏰ ${label} due: ${amount} ${fromToken} → ${toToken}. Tap Execute to review & sign.`,
      severity: 'info',
      action:   `__EXEC__:${item.id}`,   // UI detects this prefix → calls execute-scheduled endpoint
    })
    schedulerEvents.emit('due', item)
    return
  }

  try {
    const [{ Ed25519Keypair }, { decodeSuiPrivateKey }, jsonRpcMod] = await Promise.all([
      import('@mysten/sui/keypairs/ed25519'),
      import('@mysten/sui/cryptography'),
      import('@mysten/sui/jsonRpc'),
    ])
    const SuiClient      = jsonRpcMod.SuiJsonRpcClient
    const getFullnodeUrl = jsonRpcMod.getJsonRpcFullnodeUrl

    const { secretKey } = decodeSuiPrivateKey(privateKey)
    const keypair       = Ed25519Keypair.fromSecretKey(secretKey)
    const wallet        = keypair.getPublicKey().toSuiAddress()

    const amountIn = BigInt(Math.round(amount * (TOKEN_DECIMALS[fromToken] ?? 1e9)))

    const { default: Routex } = await import('routex-sui')
    const routex = new Routex('mainnet', wallet)
    const quote  = await routex.getQuote({
      from:              fromToken,
      to:                toToken,
      amount:            amountIn,
      slippageTolerance: 0.005,
      senderAddress:     wallet,
    })

    const suiClient = new SuiClient({ url: getFullnodeUrl('mainnet'), network: 'mainnet' })
    const result    = await suiClient.signAndExecuteTransaction({
      signer:      keypair,
      transaction: quote.ptb,
      options:     { showEffects: true },
    })

    addAlert(item.wallet, {
      type:     'scheduled',
      message:  `✓ ${label} executed: ${amount} ${fromToken} → ${toToken}. TX: ${result.digest.slice(0, 12)}…${result.digest.slice(-6)}`,
      severity: 'info',
    })
    schedulerEvents.emit('executed', { item, digest: result.digest })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    addAlert(item.wallet, {
      type:     'scheduled',
      message:  `⚠️ ${label} triggered (${amount} ${fromToken} → ${toToken}) but auto-execute failed: ${errMsg.slice(0, 120)}`,
      severity: 'warning',
    })
    schedulerEvents.emit('due', item)
  }
}

export function startScheduler() {
  console.log('  Scheduler   →  checking every minute')

  cron.schedule('* * * * *', async () => {
    const now       = Date.now()
    const scheduled = getAllScheduled()

    for (const item of scheduled) {
      const nextRun = new Date(item.schedule.nextRun).getTime()
      if (nextRun > now) continue

      // Advance schedule (or mark done for one-time)
      const next = nextRunAfter(item)
      markScheduledRun(item.id, next)

      // Fire: auto-execute if we have a server key, otherwise alert
      await tryAutoExecute(item)
    }
  })
}
