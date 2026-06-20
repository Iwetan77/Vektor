/**
 * Condition monitor — polls Pyth price feeds every 30 seconds.
 * When a condition is met:
 *   • If SUI_PRIVATE_KEY is set → auto-executes the swap server-side
 *   • Otherwise → sends an actionable alert with the current price
 */

import { EventEmitter }          from 'events'
import { PriceServiceConnection } from '@pythnetwork/price-service-client'
import { getAllConditions, markConditionFired, syncStoreFromKV, type Condition } from '../db/store.js'
import { addAlert }               from '../memory/index.js'
import { internalBaseUrl }        from '../lib/internal-url.js'

export const conditionEvents = new EventEmitter()

const PYTH_ENDPOINT = 'https://hermes.pyth.network'

const PYTH_FEED_IDS: Record<string, string> = {
  SUI:  '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
  ETH:  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BTC:  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
}

let priceCache: Record<string, number> = {}

async function refreshPrices(): Promise<void> {
  try {
    const conn  = new PriceServiceConnection(PYTH_ENDPOINT)
    const ids   = Object.values(PYTH_FEED_IDS)
    const feeds = await conn.getLatestPriceFeeds(ids)

    for (const feed of feeds ?? []) {
      const price = (feed as any).getPriceUnchecked?.()
      if (!price) continue
      const usd = Number(price.price) * 10 ** Number(price.expo)
      const sym = Object.entries(PYTH_FEED_IDS).find(([, id]) =>
        id === (feed as any).id || id === '0x' + (feed as any).id
      )?.[0]
      if (sym) priceCache[sym] = Math.abs(usd)
    }
  } catch { /* silent */ }
}

function checkCondition(cond: Condition, prices: Record<string, number>): boolean {
  const { type, asset, threshold } = cond.trigger
  const price = prices[asset.toUpperCase()]
  if (price === undefined) return false

  if (type === 'price_below') return price < threshold
  if (type === 'price_above') return price > threshold
  return false
}

export function getCurrentPrice(symbol: string): number | null {
  return priceCache[symbol.toUpperCase()] ?? null
}

/** Returns the full price cache — used by /api/prices endpoint */
export function getAllPrices(): Record<string, number> {
  return { ...priceCache }
}

const TOKEN_DECIMALS: Record<string, number> = {
  SUI: 1e9, USDC: 1e6, USDT: 1e6, DEEP: 1e6, WETH: 1e8, WBTC: 1e8, BUCK: 1e9,
}

/**
 * Preferred path: execute the condition's action autonomously via the user's
 * Echo session key (a delegated, on-chain-capped ephemeral key) so it works
 * while the user is offline, without any server-wide SUI_PRIVATE_KEY. Routes
 * through /api/echo/:wallet/execute so the on-chain spend-cap check runs
 * atomically. Returns true only if the swap actually executed.
 */
async function tryEchoSessionExecute(
  cond: Condition,
  fromToken: string,
  toToken: string,
  amount: number,
  currentPrice: number,
): Promise<boolean> {
  if (!cond.autoExecute) return false
  const workerSecret = process.env.ECHO_WORKER_SECRET
  if (!workerSecret) return false
  try {
    const [{ loadSessionKeypair }, { readEchoData }] = await Promise.all([
      import('../echo/session.js'),
      import('../echo/walrus.js'),
    ])
    const keypair = await loadSessionKeypair(cond.wallet)
    if (!keypair) return false
    const meta = (await readEchoData(cond.wallet)).sessionKeyMetadata
    if (!meta || meta.expiresAt <= Date.now()) return false

    const resp = await fetch(`${internalBaseUrl()}/api/echo/${cond.wallet}/execute`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-echo-worker-secret': workerSecret },
      body:    JSON.stringify({ from: fromToken, to: toToken, amount }),
    })
    const json = await resp.json().catch(() => ({} as any))
    if (!resp.ok || !json?.digest) return false   // cap exceeded / quote failed → fall through

    const digest = String(json.digest)
    addAlert(cond.wallet, {
      type:     'condition',
      message:  `✓ Auto-executed via Echo session key: ${amount} ${fromToken} → ${toToken} at $${currentPrice.toFixed(4)}. TX: ${digest.slice(0, 12)}…${digest.slice(-6)}`,
      severity: 'info',
    })
    conditionEvents.emit('executed', { condition: cond, digest, currentPrice })
    return true
  } catch {
    return false
  }
}

/** Try to auto-execute a condition's action server-side using the wallet keypair */
async function tryAutoExecute(cond: Condition, currentPrice: number): Promise<void> {
  // 1. Per-user Echo session key (offline-friendly, on-chain capped).
  {
    const parsed    = cond.action
    const fromToken = (parsed.input_asset ?? cond.trigger.asset ?? 'SUI').toUpperCase()
    const toToken   = (parsed.output_goal ?? 'USDC').toUpperCase()
    const amount    = parsed.input_amount ?? 0
    if (amount > 0 && await tryEchoSessionExecute(cond, fromToken, toToken, amount, currentPrice)) return
  }

  const privateKey = process.env.SUI_PRIVATE_KEY
  if (!privateKey) {
    // No key — send a rich actionable alert
    const dir = cond.trigger.type === 'price_below' ? 'dropped below' : 'rose above'
    addAlert(cond.wallet, {
      type:     'condition',
      message:  `⚡ Condition triggered: ${cond.trigger.asset} has ${dir} $${cond.trigger.threshold}. Current price: $${currentPrice.toFixed(4)}. Open Vektor to execute.`,
      severity: 'warning',
    })
    return
  }

  try {
    // Dynamic import so the module loads fine even if @mysten/sui isn't used elsewhere
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

    const parsed    = cond.action
    const fromToken = (parsed.input_asset ?? 'SUI').toUpperCase()
    const toToken   = (parsed.output_goal ?? 'USDC').toUpperCase()
    const amount    = parsed.input_amount ?? 0
    const amountIn  = BigInt(Math.round(amount * (TOKEN_DECIMALS[fromToken] ?? 1e9)))

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

    addAlert(cond.wallet, {
      type:     'condition',
      message:  `✓ Auto-executed: ${amount} ${fromToken} → ${toToken} at $${currentPrice.toFixed(4)}. TX: ${result.digest.slice(0, 12)}…${result.digest.slice(-6)}`,
      severity: 'info',
    })
    conditionEvents.emit('executed', { condition: cond, digest: result.digest, currentPrice })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    addAlert(cond.wallet, {
      type:     'condition',
      message:  `⚠️ Condition triggered (${cond.trigger.asset} @ $${currentPrice.toFixed(4)}) but auto-execute failed: ${errMsg.slice(0, 120)}`,
      severity: 'warning',
    })
  }
}

/**
 * One evaluation pass: refresh prices, then fire any met conditions. Used by the
 * local setInterval AND by the serverless /api/cron/tick endpoint (Vercel has no
 * long-running process, so the cron drives this instead of setInterval).
 */
export async function runConditionTick(): Promise<{ checked: number; fired: number }> {
  await syncStoreFromKV(true)   // ensure we see conditions written by any instance
  await refreshPrices()
  const conditions = getAllConditions()
  let fired = 0

  for (const cond of conditions) {
    if (!checkCondition(cond, priceCache)) continue

    markConditionFired(cond.id)
    fired++

    const price = priceCache[cond.trigger.asset.toUpperCase()] ?? 0
    conditionEvents.emit('triggered', { condition: cond, currentPrice: price })

    await tryAutoExecute(cond, price)
  }
  return { checked: conditions.length, fired }
}

export function startConditionMonitor() {
  console.log('  Conditions  →  polling Pyth every 30s')
  runConditionTick().catch(() => {})
  setInterval(() => runConditionTick().catch(() => {}), 30_000)
}
