/**
 * Guardian v2 — scored risk engine used by the Vektor UI server.
 *
 * Runs all 7 risk checks in parallel, calculates a 0–100 score,
 * and returns a GuardianReport compatible with the UI components.
 */

import { PriceServiceConnection } from '@pythnetwork/price-service-client'
import { calculateScore, scoreToLevel } from './scorer.js'
import { complete, LANG_NAMES }      from '../ai/client.js'

export interface RiskFlag {
  class:       1 | 2 | 3 | 4 | 5 | 6 | 7
  severity:    'green' | 'yellow' | 'red'
  title:       string
  message:     string
  suggestion?: 'split_trade' | 'reroute' | 'rebuild'
}

export interface GuardianReportV2 {
  score:            number
  level:            'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  flags:            RiskFlag[]
  canProceed:       boolean
  rewriteAvailable: boolean
  originalQuote:    any
  rewrittenQuote?:  any
}

/**
 * Strip a raw Routex quote down to the plain-object fields that the UI and
 * rewritePTB actually need. Removes the `ptb` Transaction class instance
 * (which contains BigInts in non-enumerable class fields that trip JSON.stringify)
 * and normalises all BigInt amount fields to decimal strings.
 */
export function stripQuoteForJson(quote: any): any {
  const str = (v: unknown) => (v == null ? '0' : String(v))
  return {
    fromSymbol:        quote.fromSymbol  ?? quote.from?.symbol  ?? '',
    toSymbol:          quote.toSymbol    ?? quote.to?.symbol    ?? '',
    amountIn:          str(quote.amountIn),
    amountOut:         str(quote.amountOut),
    slippageTolerance: quote.slippageTolerance ?? 0.005,
    priceImpact:       quote.priceImpact       ?? 0,
    gasEstimate:       str(quote.gasEstimate),
    validUntil:        quote.validUntil,
    route:             (quote.route ?? []).map((s: any) => ({ protocol: s.protocol, poolId: s.poolId })),
    _split:            quote._split,
  }
}

// ─── Pyth price feed IDs for Sui ─────────────────────────────────────────────

const PYTH_ENDPOINT = 'https://hermes.pyth.network'
const STALE_SECONDS  = 120

const PYTH_FEED_IDS: Record<string, string> = {
  SUI:  '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
}

// ─── Protocol registry for age / audit check ─────────────────────────────────

const PROTOCOL_REGISTRY: Record<string, { audited: boolean; launchDate: number }> = {
  navi:      { audited: true,  launchDate: 1690000000 },
  cetus:     { audited: true,  launchDate: 1672000000 },
  aftermath: { audited: true,  launchDate: 1685000000 },
  scallop:   { audited: true,  launchDate: 1688000000 },
  deepbook:  { audited: true,  launchDate: 1680000000 },
  turbos:    { audited: true,  launchDate: 1683000000 },
  bluefin:   { audited: true,  launchDate: 1686000000 },
}

const GAS_BASELINE: Record<string, bigint> = {
  direct:       3_000_000n,
  'single-hop': 6_000_000n,
  'multi-hop':  9_000_000n,
}

// ─── Risk Class 1 — Slippage ─────────────────────────────────────────────────

function checkSlippage(quote: any): RiskFlag {
  const s = quote.priceImpact ?? 0
  if (s < 0.005) return { class: 1, severity: 'green',  title: 'Slippage acceptable', message: `Estimated slippage: ${(s * 100).toFixed(3)}%` }
  if (s < 0.02)  return { class: 1, severity: 'yellow', title: 'Slippage borderline',
    message: `Slippage ${(s * 100).toFixed(2)}% — trade size is moderate relative to pool depth.`, suggestion: 'split_trade' }
  return { class: 1, severity: 'red', title: 'High slippage',
    message: `Slippage ${(s * 100).toFixed(2)}% — you'll receive significantly less than the quoted price.`, suggestion: 'split_trade' }
}

// ─── Risk Class 2 — Oracle freshness ─────────────────────────────────────────

async function checkOracle(quote: any): Promise<RiskFlag> {
  try {
    const fromId = PYTH_FEED_IDS[quote.fromSymbol ?? quote.from?.symbol ?? '']
    const toId   = PYTH_FEED_IDS[quote.toSymbol   ?? quote.to?.symbol   ?? '']
    const ids    = [fromId, toId].filter(Boolean) as string[]

    if (ids.length === 0) {
      return { class: 2, severity: 'green', title: 'Oracle check skipped', message: 'No Pyth feed available for this pair — routing via on-chain pools.' }
    }

    const conn  = new PriceServiceConnection(PYTH_ENDPOINT)
    const feeds = await conn.getLatestPriceFeeds(ids)

    for (const feed of feeds ?? []) {
      const age = (Date.now() / 1000) - (feed as any).getPriceUnchecked?.()?.publishTime
      if (age > STALE_SECONDS) {
        return { class: 2, severity: 'yellow', title: 'Stale price oracle',
          message: `Price feed last updated ${Math.floor(age / 60)}m ago. Executing at a potentially stale rate.` }
      }
    }
    return { class: 2, severity: 'green', title: 'Oracle fresh', message: 'All Pyth price feeds are current.' }
  } catch {
    return { class: 2, severity: 'green', title: 'Oracle check skipped', message: 'Could not reach Pyth — proceeding without oracle check.' }
  }
}

// ─── Risk Class 3 — Ghost pool ───────────────────────────────────────────────

async function checkGhostPool(quote: any, suiClient: any): Promise<RiskFlag> {
  try {
    for (const step of quote.route ?? []) {
      if (!step.poolId || !suiClient) continue
      // Query recent events for this pool to check activity
      const events = await suiClient.queryEvents({
        query:      { MoveEventModule: { package: step.poolId.split('::')[0], module: 'pool' } },
        limit:      1,
        descending: true,
      })
      if (events?.data?.length === 0) {
        return { class: 3, severity: 'yellow', title: 'Low pool activity',
          message: `No recent events found for pool ${step.protocol}. Execution quality may be unpredictable.`, suggestion: 'reroute' }
      }
    }
    return { class: 3, severity: 'green', title: 'Pools active', message: 'All pools have recent trade activity.' }
  } catch {
    return { class: 3, severity: 'green', title: 'Pool activity check skipped', message: 'Could not verify pool activity — proceeding with best available route.' }
  }
}

// ─── Risk Class 4 — Price impact ─────────────────────────────────────────────

function checkPriceImpact(quote: any): RiskFlag {
  const impact = quote.priceImpact ?? 0
  if (impact > 0.05) return { class: 4, severity: 'red',    title: 'High price impact',
    message: `Your trade moves the price by ${(impact * 100).toFixed(2)}%. Executing against yourself.`, suggestion: 'split_trade' }
  if (impact > 0.01) return { class: 4, severity: 'yellow', title: 'Moderate price impact',
    message: `Price impact: ${(impact * 100).toFixed(2)}%. Your trade size relative to pool depth is notable.`, suggestion: 'split_trade' }
  return { class: 4, severity: 'green', title: 'Price impact acceptable', message: `Price impact: ${(impact * 100).toFixed(4)}%. Within safe limits.` }
}

// ─── Risk Class 5 — Concentration ────────────────────────────────────────────

async function checkConcentration(quote: any, walletAddress: string, suiClient: any): Promise<RiskFlag> {
  try {
    if (!suiClient || !walletAddress || walletAddress.startsWith('0x000')) {
      return { class: 5, severity: 'green', title: 'Concentration check skipped', message: 'Connect a wallet to enable portfolio concentration analysis.' }
    }
    const balance = await suiClient.getBalance({ owner: walletAddress, coinType: '0x2::sui::SUI' })
    const suiTotal = Number(BigInt(balance.totalBalance)) / 1e9
    const amountIn = Number(BigInt(quote.amountIn ?? 0)) / 1e9
    const concentration = suiTotal > 0 ? amountIn / suiTotal : 0

    if (concentration > 0.9) return { class: 5, severity: 'red',    title: 'Extreme concentration risk',
      message: `This trade uses ${(concentration * 100).toFixed(0)}% of your SUI. You'll have no gas reserve.` }
    if (concentration > 0.8) return { class: 5, severity: 'yellow', title: 'Concentration risk',
      message: `This moves ${(concentration * 100).toFixed(0)}% of your portfolio. Consider keeping a buffer for gas and flexibility.` }
    return { class: 5, severity: 'green', title: 'Concentration acceptable', message: 'Portfolio balance looks healthy after this trade.' }
  } catch {
    return { class: 5, severity: 'green', title: 'Concentration check skipped', message: 'Could not read wallet balance.' }
  }
}

// ─── Risk Class 6 — Protocol age / audit ─────────────────────────────────────

function checkProtocolAge(quote: any): RiskFlag {
  for (const step of quote.route ?? []) {
    const key      = (step.protocol ?? '').toLowerCase()
    const protocol = PROTOCOL_REGISTRY[key]

    if (!protocol) {
      return { class: 6, severity: 'red', title: 'Unknown protocol',
        message: `${step.protocol} is not in Vektor's registry. It may be unaudited.`, suggestion: 'reroute' }
    }
    if (!protocol.audited) {
      return { class: 6, severity: 'yellow', title: 'Unaudited protocol',
        message: `${step.protocol} has no public audit on record. Smart contract risk is elevated.` }
    }
    const daysSinceLaunch = (Date.now() / 1000 - protocol.launchDate) / 86400
    if (daysSinceLaunch < 60) {
      return { class: 6, severity: 'yellow', title: 'New protocol',
        message: `${step.protocol} launched ${Math.floor(daysSinceLaunch)} days ago and has a limited track record.` }
    }
  }
  return { class: 6, severity: 'green', title: 'Protocols verified', message: 'All protocols are audited and established.' }
}

// ─── Risk Class 7 — Gas anomaly ──────────────────────────────────────────────

function checkGasAnomaly(quote: any): RiskFlag {
  const hops     = quote.route?.length ?? 1
  const key      = hops === 0 ? 'direct' : hops === 1 ? 'single-hop' : 'multi-hop'
  const baseline = GAS_BASELINE[key] ?? 5_000_000n
  const gas      = BigInt(quote.gasEstimate ?? 0)
  const ratio    = gas > 0n ? Number(gas) / Number(baseline) : 0

  if (ratio > 5)  return { class: 7, severity: 'red',    title: 'Gas anomaly detected',
    message: `Gas is ${ratio.toFixed(1)}x above normal for a ${key} swap. The route may be malformed.`, suggestion: 'rebuild' }
  if (ratio > 3)  return { class: 7, severity: 'yellow', title: 'Elevated gas cost',
    message: `Gas is ${ratio.toFixed(1)}x above baseline — check the route complexity.` }
  return { class: 7, severity: 'green', title: 'Gas cost normal',
    message: `Gas estimate is within expected range for a ${key} swap.` }
}

// ─── Guardian flag translator ─────────────────────────────────────────────────

/**
 * Translate Guardian flag titles and messages into the user's language.
 * Protocol names, token symbols, and percentages are preserved in English.
 * Runs as a single batched AI call for all flags to minimise latency.
 */
async function translateGuardianFlags(flags: RiskFlag[], lang: string): Promise<RiskFlag[]> {
  // Only translate when the language is not English
  if (!lang || lang === 'en') return flags

  const langName = LANG_NAMES[lang] ?? lang

  try {
    const payload = flags.map(f => ({ title: f.title, message: f.message }))
    const raw = await complete({
      system: `You are a DeFi risk report translator.
Translate the following Guardian risk-check entries into ${langName}.
Rules:
- Keep ALL protocol names in English: Cetus, Aftermath, NAVI, DeepBook, Turbos, Bluefin, Scallop
- Keep ALL token symbols in English: SUI, USDC, USDT, WETH, WBTC, DEEP
- Keep all numbers, percentages, wallet addresses unchanged
- For Yoruba, Hausa, Igbo, Swahili: DeFi technical terms like "slippage", "liquidity", "oracle", "pool" may stay in English if no natural translation exists
- Return ONLY a valid JSON array with the same number of items, each with "title" and "message" string fields
- No preamble, no explanation, no markdown`,
      prompt:     JSON.stringify(payload),
      maxTokens:  1200,
    })
    const cleaned    = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    const translated = JSON.parse(cleaned) as Array<{ title: string; message: string }>
    if (!Array.isArray(translated) || translated.length !== flags.length) return flags
    return flags.map((f, i) => ({
      ...f,
      title:   translated[i]?.title   ?? f.title,
      message: translated[i]?.message ?? f.message,
    }))
  } catch {
    // Translation failed — return original English flags rather than crashing
    return flags
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function runGuardian(
  quote:         any,
  walletAddress: string,
  suiClient:     any,
  lang           = 'en',
): Promise<GuardianReportV2> {
  const results = await Promise.allSettled([
    Promise.resolve(checkSlippage(quote)),
    checkOracle(quote),
    checkGhostPool(quote, suiClient),
    Promise.resolve(checkPriceImpact(quote)),
    checkConcentration(quote, walletAddress, suiClient),
    Promise.resolve(checkProtocolAge(quote)),
    Promise.resolve(checkGasAnomaly(quote)),
  ])

  const flags = results
    .map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      // If a check throws, treat as skipped (green)
      const classes = [1, 2, 3, 4, 5, 6, 7] as const
      return { class: classes[i], severity: 'green' as const, title: 'Check skipped', message: 'Could not complete this risk check.' }
    })

  const score = calculateScore(flags)
  const level = scoreToLevel(score)

  // Translate flag messages into user's language (no-op for English)
  const localizedFlags = await translateGuardianFlags(flags, lang)

  return {
    score,
    level,
    flags:            localizedFlags,
    canProceed:       level !== 'CRITICAL',
    rewriteAvailable: flags.some(f => f.severity !== 'green' && f.suggestion != null),
    originalQuote:    stripQuoteForJson(quote),
  }
}
