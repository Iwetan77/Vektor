/**
 * Proactive alert monitor — runs every 5 minutes, checks all active wallets.
 * Surfaces alerts for health factor, idle stablecoins, upcoming payments, etc.
 */

import { getHealthFactor } from '../navi/client.js'
import { getAllScheduled, getAllOpenPositions, getAllConditions } from '../db/store.js'
import { addAlert, getMemory, saveMemory } from '../memory/index.js'
import { getCurrentPrice } from '../conditions/monitor.js'

// Set of wallets we're monitoring (registered on connect)
const WATCHED_WALLETS = new Set<string>()

export function registerWallet(wallet: string) {
  WATCHED_WALLETS.add(wallet)
}

async function checkWallet(wallet: string) {
  // 1. NAVI health factor
  try {
    const hf = await getHealthFactor(wallet)
    if (hf !== null) {
      const mem = getMemory(wallet)
      mem.naviHealthFactor = hf
      saveMemory(mem)

      if (hf < 1.3) {
        addAlert(wallet, {
          type:     'health_factor',
          message:  `⚠️ NAVI health factor is ${hf.toFixed(2)} — approaching liquidation threshold. Consider repaying debt or adding collateral.`,
          severity: 'critical',
        })
      } else if (hf < 1.5) {
        addAlert(wallet, {
          type:     'health_factor',
          message:  `Health factor is ${hf.toFixed(2)} — getting close to the 1.5 safety threshold. Monitor closely.`,
          severity: 'warning',
        })
      }
    }
  } catch { /* ignore */ }

  // 2. Upcoming scheduled payments (within 24 hours)
  const scheduled = getAllScheduled().filter(s => s.wallet === wallet)
  for (const item of scheduled) {
    const nextRun = new Date(item.schedule.nextRun).getTime()
    const hoursAway = (nextRun - Date.now()) / 3_600_000
    if (hoursAway > 0 && hoursAway < 24) {
      addAlert(wallet, {
        type:     'scheduled',
        message:  `Reminder: ${item.type === 'dca' ? 'DCA' : 'Payment'} of ${item.amount} ${item.token} scheduled in ${Math.round(hoursAway)}h.`,
        severity: 'info',
      })
    }
  }

  // 3. Open memecoin positions.
  // Vektor has no live price oracle for arbitrary memecoins, so we deliberately
  // never compute or show a current price or P/L — any such number would be
  // fabricated. We only echo the target/stop the user configured and state
  // plainly that the live price is unavailable.
  const positions = getAllOpenPositions().filter(p => p.wallet === wallet)
  for (const pos of positions) {
    if (pos.profitTarget ?? pos.stopLoss) {
      const targets = [
        pos.profitTarget ? `target +${(pos.profitTarget * 100).toFixed(0)}%` : '',
        pos.stopLoss     ? `stop -${(pos.stopLoss * 100).toFixed(0)}%`       : '',
      ].filter(Boolean).join(', ')
      addAlert(wallet, {
        type:     'position',
        message:  `Open ${pos.token} position — live price unavailable, monitoring ${targets}.`,
        severity: 'info',
      })
    }
  }

  // 4. Conditions that are close to firing
  const conditions = getAllConditions().filter(c => c.wallet === wallet)
  for (const cond of conditions) {
    if (cond.trigger.type === 'price_below' || cond.trigger.type === 'price_above') {
      const currentPrice = getCurrentPrice(cond.trigger.asset)
      if (currentPrice === null) continue
      const threshold = cond.trigger.threshold
      const distancePct = Math.abs(currentPrice - threshold) / threshold

      if (distancePct < 0.05) { // within 5% of trigger
        const dir = cond.trigger.type === 'price_below' ? 'below' : 'above'
        addAlert(wallet, {
          type:     'condition',
          message:  `Condition almost triggered: ${cond.trigger.asset} is within 5% of your $${threshold} ${dir} threshold (currently $${currentPrice.toFixed(4)}).`,
          severity: 'warning',
        })
      }
    }
  }
}

export function startAlertMonitor() {
  console.log('  Alerts      →  checking every 5 minutes')

  async function tick() {
    for (const wallet of WATCHED_WALLETS) {
      await checkWallet(wallet).catch(() => {})
    }
  }

  // Run every 5 minutes
  tick().catch(() => {})
  setInterval(() => tick().catch(() => {}), 5 * 60_000)
}
