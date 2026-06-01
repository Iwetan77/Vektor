/**
 * Portfolio fetcher — pulls token balances, NAVI positions, and recent transactions
 * from Sui RPC. Used on wallet connect and for portfolio analysis.
 */

import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from '@mysten/sui/jsonRpc'
import { getAddressPortfolio, getHealthFactorCall } from 'navi-sdk'

const client = new SuiClient({ url: getFullnodeUrl('mainnet'), network: 'mainnet' } as any)

/* ─── Known tokens ───────────────────────────────────────────────────────── */

const KNOWN_COINS: Record<string, { symbol: string; decimals: number }> = {
  // SUI
  '0x2::sui::SUI':                                                                                            { symbol: 'SUI',   decimals: 9 },
  // Native Circle USDC (used by Routex, Cetus, Aftermath)
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC':                        { symbol: 'USDC',  decimals: 6 },
  // Legacy Wormhole bridged USDC
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN':                        { symbol: 'USDC',  decimals: 6 },
  // USDT
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN':                        { symbol: 'USDT',  decimals: 6 },
  // WETH
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN':                        { symbol: 'WETH',  decimals: 8 },
  // WBTC
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN':                        { symbol: 'WBTC',  decimals: 8 },
  // DEEP (Routex mainnet address)
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP':                        { symbol: 'DEEP',  decimals: 6 },
  // haSUI / vSUI
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI':                     { symbol: 'haSUI', decimals: 9 },
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT':                       { symbol: 'vSUI',  decimals: 9 },
  // afSUI (Aftermath)
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI':                     { symbol: 'afSUI', decimals: 9 },
}

/* ─── Price fetching ─────────────────────────────────────────────────────── */

// Source 1: DeFi Llama — free, no auth, highly reliable
async function fetchPricesDefiLlama(): Promise<Record<string, number>> {
  const keys = [
    'coingecko:sui',
    'coingecko:usd-coin',
    'coingecko:tether',
    'coingecko:weth',
    'coingecko:wrapped-bitcoin',
    'coingecko:deepbook',
  ].join(',')
  const res  = await fetch(`https://coins.llama.fi/prices/current/${keys}`, { signal: AbortSignal.timeout(6000) })
  const json = await res.json() as { coins: Record<string, { price: number }> }
  const c    = json.coins
  const sui  = c['coingecko:sui']?.price ?? 0
  return {
    SUI:   sui,
    USDC:  c['coingecko:usd-coin']?.price       ?? 1,
    USDT:  c['coingecko:tether']?.price          ?? 1,
    WETH:  c['coingecko:weth']?.price            ?? 0,
    WBTC:  c['coingecko:wrapped-bitcoin']?.price ?? 0,
    DEEP:  c['coingecko:deepbook']?.price        ?? 0,
    haSUI: sui,
    vSUI:  sui,
  }
}

// Source 2: Coinbase public API — no auth needed
async function fetchSuiPriceCoinbase(): Promise<number> {
  const res  = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=SUI', { signal: AbortSignal.timeout(5000) })
  const json = await res.json() as { data: { rates: Record<string, string> } }
  return parseFloat(json.data.rates['USD'] ?? '0') || 0
}

async function fetchPricesUsd(): Promise<Record<string, number>> {
  // Try DeFi Llama first
  try {
    const prices = await fetchPricesDefiLlama()
    if (prices.SUI > 0) return prices
  } catch { /* fall through */ }

  // Fallback: Coinbase for SUI, stablecoins default to $1
  try {
    const sui = await fetchSuiPriceCoinbase()
    return { SUI: sui, USDC: 1, USDT: 1, WETH: 0, WBTC: 0, DEEP: 0, haSUI: sui, vSUI: sui }
  } catch { /* fall through */ }

  // Last resort: return zeros (portfolio still shows, just without USD values)
  return { SUI: 0, USDC: 1, USDT: 1, WETH: 0, WBTC: 0, DEEP: 0, haSUI: 0, vSUI: 0 }
}

/* ─── Main portfolio fetch ───────────────────────────────────────────────── */

export interface TokenBalance {
  coinType: string
  symbol:   string
  raw:      string
  formatted: string
  usdValue:  number
}

export interface PortfolioSnapshot {
  wallet:     string
  fetchedAt:  string
  totalUsd:   number
  balances:   TokenBalance[]
  navi?: {
    supplyBalances: Record<string, number>
    borrowBalances: Record<string, number>
    healthFactor:   number | null
  }
  recentTxs:  RecentTx[]
}

export interface RecentTx {
  digest:    string
  timestamp: string
  kind:      string
  status:    'success' | 'failure'
}

/**
 * Fetch recent transactions for a wallet — both sent and received.
 * Much faster than fetchPortfolio because it skips coin balances,
 * prices, and NAVI positions.
 */
export async function fetchRecentTxs(wallet: string, limit = 20): Promise<RecentTx[]> {
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('tx fetch timeout')), 8_000)
  )

  // Query both sent and received txs in parallel
  const [sentResult, receivedResult] = await Promise.allSettled([
    Promise.race([
      client.queryTransactionBlocks({
        filter:  { FromAddress: wallet },
        options: { showEffects: true },
        limit,
        order:   'descending',
      }),
      deadline,
    ]),
    Promise.race([
      client.queryTransactionBlocks({
        filter:  { ToAddress: wallet },
        options: { showEffects: true },
        limit,
        order:   'descending',
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('tx fetch timeout')), 8_000)
      ),
    ]),
  ])

  const sentData     = sentResult.status     === 'fulfilled' ? sentResult.value.data     : []
  const receivedData = receivedResult.status === 'fulfilled' ? receivedResult.value.data : []

  // Merge, deduplicate by digest, sort newest first
  const seen = new Set<string>()
  const all  = [...sentData, ...receivedData].filter(tx => {
    if (seen.has(tx.digest)) return false
    seen.add(tx.digest)
    return true
  })

  all.sort((a, b) => {
    const ta = Number((a as any).timestampMs ?? 0)
    const tb = Number((b as any).timestampMs ?? 0)
    return tb - ta
  })

  return all.slice(0, limit).map((tx: any) => ({
    digest:    tx.digest,
    timestamp: tx.timestampMs ? new Date(Number(tx.timestampMs)).toISOString() : '',
    kind:      'transaction',
    status:    tx.effects?.status?.status === 'success' ? 'success' : 'failure',
  }))
}

/** Fetch coins with fast retry — up to 3 attempts with 300ms gaps. */
async function fetchAllCoinsWithRetry(wallet: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 300))
    try {
      const result = await client.getAllCoins({ owner: wallet })
      if (result.data.length > 0) return result
    } catch { /* try again */ }
  }
  // Last attempt — return whatever we get (may be empty)
  return client.getAllCoins({ owner: wallet })
}

/** Fetch NAVI positions with a hard 4-second timeout. */
async function fetchNaviPositions(wallet: string): Promise<PortfolioSnapshot['navi']> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('NAVI timeout')), 4000)
    )
    const portfolio = await Promise.race([
      getAddressPortfolio(wallet, false, client as any),
      timeout,
    ]) as Map<string, { supplyBalance: number; borrowBalance: number }>

    let healthFactor: number | null = null
    try {
      const hfRes = await Promise.race([
        getHealthFactorCall(wallet, client as any),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('HF timeout')), 3000)),
      ])
      healthFactor = typeof hfRes === 'number' ? hfRes : null
    } catch { /* ignore */ }

    const supplyBalances: Record<string, number> = {}
    const borrowBalances: Record<string, number> = {}
    for (const [symbol, data] of portfolio) {
      if (data.supplyBalance > 0) supplyBalances[symbol] = data.supplyBalance
      if (data.borrowBalance > 0) borrowBalances[symbol] = data.borrowBalance
    }
    if (Object.keys(supplyBalances).length > 0 || Object.keys(borrowBalances).length > 0) {
      return { supplyBalances, borrowBalances, healthFactor }
    }
    return undefined
  } catch {
    return undefined
  }
}

export async function fetchPortfolio(wallet: string): Promise<PortfolioSnapshot> {
  // Run everything in parallel — NAVI and tx history no longer block balance display.
  const txTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('tx history timeout')), 5000)
  )
  const [allCoins, prices, recentTxs, naviResult] = await Promise.allSettled([
    fetchAllCoinsWithRetry(wallet),
    fetchPricesUsd(),
    Promise.race([
      client.queryTransactionBlocks({
        filter:  { FromAddress: wallet },
        options: { showInput: false, showEffects: true },
        limit:   20,
        order:   'descending',
      }),
      txTimeout,
    ]),
    fetchNaviPositions(wallet),
  ])

  const coins    = allCoins.status   === 'fulfilled' ? allCoins.value.data  : []
  const priceMap = prices.status     === 'fulfilled' ? prices.value          : {}
  const txData   = recentTxs.status  === 'fulfilled' ? recentTxs.value.data : []
  const navi     = naviResult.status === 'fulfilled' ? naviResult.value      : undefined

  // Aggregate by coin type
  const aggregated = new Map<string, bigint>()
  for (const coin of coins) {
    const existing = aggregated.get(coin.coinType) ?? 0n
    aggregated.set(coin.coinType, existing + BigInt(coin.balance))
  }

  const balances: TokenBalance[] = []
  for (const [coinType, raw] of aggregated) {
    const known    = KNOWN_COINS[coinType]
    const symbol   = known?.symbol ?? coinType.split('::').pop() ?? coinType.slice(0, 6)
    const decimals = known?.decimals ?? 9
    const formatted = (Number(raw) / 10 ** decimals).toFixed(decimals >= 9 ? 4 : 6)
    const usdValue  = Number(formatted) * (priceMap[symbol] ?? 0)
    if (Number(formatted) < 0.000001) continue
    balances.push({ coinType, symbol, raw: raw.toString(), formatted, usdValue })
  }

  balances.sort((a, b) => b.usdValue - a.usdValue)
  const totalUsd = balances.reduce((s, b) => s + b.usdValue, 0)

  const recentTxList: RecentTx[] = txData.map((tx: any) => ({
    digest:    tx.digest,
    timestamp: tx.timestampMs ? new Date(Number(tx.timestampMs)).toISOString() : '',
    kind:      'transaction',
    status:    tx.effects?.status?.status === 'success' ? 'success' : 'failure',
  }))

  return {
    wallet,
    fetchedAt: new Date().toISOString(),
    totalUsd,
    balances,
    navi,
    recentTxs: recentTxList,
  }
}

/* ─── Balance check helper ───────────────────────────────────────────────── */

/**
 * Returns the human-readable balance of a given token symbol for a wallet.
 * Sums across all matching coinTypes (handles native + bridged USDC etc.).
 * Returns Infinity for unknown tokens so the caller never blocks them.
 */
export async function getTokenBalance(wallet: string, symbol: string): Promise<number> {
  const upper = symbol.toUpperCase()
  const allBalances = await client.getAllBalances({ owner: wallet })
  let total = 0
  for (const b of allBalances) {
    const info = KNOWN_COINS[b.coinType]
    if (info?.symbol === upper) {
      total += Number(b.totalBalance) / Math.pow(10, info.decimals)
    }
  }
  // Return Infinity if token is unknown (don't block unknown coins)
  return total === 0 && !Object.values(KNOWN_COINS).some(c => c.symbol === upper)
    ? Infinity
    : total
}

/* ─── Transaction fetch for explainer ───────────────────────────────────── */

export async function fetchTransaction(digest: string) {
  return client.getTransactionBlock({
    digest,
    options: {
      showInput:          true,
      showEffects:        true,
      showEvents:         true,
      showBalanceChanges: true,
      showObjectChanges:  true,
    },
  })
}
