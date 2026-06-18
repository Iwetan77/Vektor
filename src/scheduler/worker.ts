/**
 * Scheduler worker — checks every minute for due scheduled intents.
 * When a DCA or one-time swap fires:
 *   • If SUI_PRIVATE_KEY is set → auto-executes server-side via Routex
 *   • Otherwise → queues an actionable alert for the user
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

  if (!privateKey) {
    // No server key — send an actionable alert carrying the schedule ID so the UI
    // can call /api/execute-scheduled/:id instead of re-parsing raw text.
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
