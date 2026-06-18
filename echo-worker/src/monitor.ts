/**
 * Echo monitor loop — runs every 60 seconds via Cloudflare Cron trigger.
 * Fetches all active Echo users from Sui, reads their data from Walrus,
 * evaluates their mode-specific checks, and pushes alerts/proposals.
 */

import { readEchoData }                               from './walrus'
import { runChecks }                                  from './evaluator'
import { executeRule, executeScheduledIntent }        from './executor'
import type { EchoUser, Env }                         from './types'

/* ─── Fetch all active Echo users from Sui on-chain ─────────────────────── */

async function getActiveEchoUsers(env: Env): Promise<EchoUser[]> {
  if (!env.ECHO_REGISTRY_PACKAGE_ID || env.ECHO_REGISTRY_PACKAGE_ID === 'TODO') return []

  try {
    // Query all EchoRegistry objects of the given package
    const res  = await fetch(env.SUI_RPC_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'suix_queryObjects',
        params: [{
          filter: { StructType: `${env.ECHO_REGISTRY_PACKAGE_ID}::echo_registry::EchoRegistry` },
          options: { showContent: true },
        }, null, 50, false],
      }),
    })
    const json = await res.json() as any
    const data = json?.result?.data ?? []

    const users: EchoUser[] = []
    for (const obj of data) {
      const fields  = obj?.data?.content?.fields
      if (!fields) continue
      const blobId  = new TextDecoder().decode(new Uint8Array(fields.data_blob_id))
      if (!blobId)  continue

      try {
        const echoData = await readEchoData(blobId, env)
        const watchedAssets = [
          ...echoData.conditions.map(c => c.asset),
          ...echoData.positions.map(p => p.token),
        ]
        users.push({
          address:      fields.owner,
          registryId:   obj.data.objectId,
          blobId,
          echoData,
          watchedAssets: [...new Set(watchedAssets)],
        })
      } catch {
        // Skip users whose Walrus blob can't be read
      }
    }
    return users
  } catch {
    return []
  }
}

/* ─── Fetch live prices from Pyth ────────────────────────────────────────── */

async function fetchPrices(assets: string[]): Promise<Record<string, number>> {
  if (assets.length === 0) return {}
  try {
    // Pyth price IDs for common Sui tokens
    const PRICE_IDS: Record<string, string> = {
      SUI:  'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
      USDC: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
      USDT: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
      WETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
      WBTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    }
    const ids = assets
      .map(a => PRICE_IDS[a.toUpperCase()])
      .filter(Boolean)
      .map(id => `ids[]=${id}`)
      .join('&')
    if (!ids) return {}

    const res  = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?${ids}&encoding=json`)
    const data = await res.json() as any
    const prices: Record<string, number> = {}
    for (const [sym, id] of Object.entries(PRICE_IDS)) {
      const entry = data?.parsed?.find((p: any) => p.id.toLowerCase() === id.toLowerCase())
      if (entry?.price) {
        const price    = Number(entry.price.price)
        const exp      = Number(entry.price.expo)
        prices[sym]    = price * Math.pow(10, exp)
      }
    }
    return prices
  } catch {
    return {}
  }
}

/* ─── Live data fetch via internal backend endpoints ──────────────────── */

async function fetchLiveHealthFactor(wallet: string, env: Env): Promise<number | null> {
  const baseUrl = (env as Env & { VEKTOR_BACKEND_URL?: string }).VEKTOR_BACKEND_URL
    ?? 'http://localhost:3001'
  const secret = (env as Env & { ECHO_WORKER_SECRET?: string }).ECHO_WORKER_SECRET ?? ''
  try {
    const res = await fetch(`${baseUrl}/api/internal/health-factor/${wallet}`, {
      headers: { 'x-echo-worker-secret': secret },
    })
    const body = await res.json() as { ok?: boolean; healthFactor?: number | null }
    return body?.healthFactor ?? null
  } catch { return null }
}

async function fetchLivePortfolio(wallet: string, env: Env): Promise<{
  totalUsd: number
  tokens: Array<{ symbol: string; amount: number; usdValue: number }>
  healthFactor: number | null
}> {
  const baseUrl = (env as Env & { VEKTOR_BACKEND_URL?: string }).VEKTOR_BACKEND_URL
    ?? 'http://localhost:3001'
  const secret = (env as Env & { ECHO_WORKER_SECRET?: string }).ECHO_WORKER_SECRET ?? ''
  try {
    const res = await fetch(`${baseUrl}/api/internal/portfolio/${wallet}`, {
      headers: { 'x-echo-worker-secret': secret },
    })
    const body = await res.json() as {
      ok?: boolean; totalUsd?: number
      tokens?: Array<{ symbol: string; amount: number; usdValue: number }>
      healthFactor?: number | null
    }
    return {
      totalUsd:     body?.totalUsd ?? 0,
      tokens:       body?.tokens ?? [],
      healthFactor: body?.healthFactor ?? null,
    }
  } catch {
    const hf: number | null = null
    return { totalUsd: 0, tokens: [], healthFactor: hf }
  }
}

/* ─── Process one user ───────────────────────────────────────────────────── */

async function processUser(user: EchoUser, env: Env): Promise<void> {
  try {
    const prices = await fetchPrices(user.watchedAssets)
    const [livePortfolio, liveHf] = await Promise.all([
      fetchLivePortfolio(user.address, env),
      fetchLiveHealthFactor(user.address, env),
    ])

    const tokens = livePortfolio.tokens.length > 0
      ? livePortfolio.tokens.map(t => ({
          symbol:          t.symbol,
          usdValue:        t.usdValue,
          amount:          t.amount,
          inYieldPosition: false,
        }))
      : user.echoData.positions.map(p => ({
          symbol:          p.token,
          usdValue:        (prices[p.token] ?? p.currentPrice) * p.amount,
          amount:          p.amount,
          inYieldPosition: false,
        }))

    const healthFactor = liveHf ?? livePortfolio.healthFactor
    const state = {
      portfolio: { totalUsd: livePortfolio.totalUsd, tokens, healthFactor },
      prices,
      healthFactor,
    }

    // ONE Echo — full check set always. Execution is gated per-rule via autoExecute.
    await runChecks(user, state, env)

    const now = Date.now()
    for (const intent of user.echoData.scheduledIntents) {
      if (intent.active && intent.nextExecution <= now + 60_000) {
        await executeScheduledIntent(user, intent.id, env).catch(() => {})
      }
    }
    for (const rule of user.echoData.rules.filter(r => r.active)) {
      await executeRule(rule, user, state, env).catch(() => {})
    }
  } catch (err) {
    console.error(`Echo failed for ${user.address}:`, err)
  }
}

/* ─── Main loop ──────────────────────────────────────────────────────────── */

export async function runMonitorLoop(env: Env): Promise<void> {
  const users = await getActiveEchoUsers(env)
  if (users.length === 0) return

  await Promise.allSettled(users.map(user => processUser(user, env)))
}
