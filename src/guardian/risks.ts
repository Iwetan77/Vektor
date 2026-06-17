/**
 * @deprecated Legacy Guardian risk engine. Canonical engine is `./v2.ts`.
 * Kept only because the deprecated `./index.ts` Guardian class still imports
 * its helpers. No server path imports `guardian/risks` directly.
 * Do not add new callers — extend v2 instead.
 */
import type { RoutexQuote } from 'routex-sui'
import { RiskClass, type RiskFlag, type VektorIntent } from '../types.js'

// SUI price approximation for large-trade detection (updated manually or via oracle)
// Kept conservative — used only for LARGE_TRADE threshold, not for execution math.
const APPROX_SUI_USD = 1.10
const LARGE_TRADE_USD_THRESHOLD = 5_000  // warn above ~$5k equivalent
const SUI_SCALAR = 1_000_000_000

// ─── Risk class 1: HIGH_PRICE_IMPACT ─────────────────────────────────────────
// Blocks if impact exceeds the intent's configured maxPriceImpact.
// Warns if impact exceeds 75% of the threshold (early warning).

export function checkPriceImpact(intent: VektorIntent, quote: RoutexQuote): RiskFlag | null {
  const impact = quote.priceImpact

  if (impact > intent.maxPriceImpact) {
    return {
      class: RiskClass.HIGH_PRICE_IMPACT,
      severity: 'block',
      message:
        `Price impact ${(impact * 100).toFixed(2)}% exceeds your configured maximum ` +
        `of ${(intent.maxPriceImpact * 100).toFixed(2)}%. ` +
        `Increase maxPriceImpact or reduce trade size.`,
    }
  }

  if (impact > intent.maxPriceImpact * 0.75) {
    return {
      class: RiskClass.HIGH_PRICE_IMPACT,
      severity: 'warn',
      message:
        `Price impact ${(impact * 100).toFixed(2)}% is approaching your maximum ` +
        `of ${(intent.maxPriceImpact * 100).toFixed(2)}%.`,
    }
  }

  return null
}

// ─── Risk class 2: LOOSE_SLIPPAGE ────────────────────────────────────────────
// Warns above 5%, blocks above 20%.
// High slippage makes sandwich attacks profitable against the user.

export function checkSlippage(intent: VektorIntent): RiskFlag | null {
  const s = intent.slippageTolerance

  if (s > 0.20) {
    return {
      class: RiskClass.LOOSE_SLIPPAGE,
      severity: 'block',
      message:
        `Slippage tolerance of ${(s * 100).toFixed(1)}% is dangerously high. ` +
        `At this level you can receive up to ${(s * 100).toFixed(0)}% less than quoted. ` +
        `Lower to ≤5% or use a preset: 'low' | 'medium' | 'high'.`,
    }
  }

  if (s > 0.05) {
    return {
      class: RiskClass.LOOSE_SLIPPAGE,
      severity: 'warn',
      message:
        `Slippage tolerance of ${(s * 100).toFixed(1)}% is higher than recommended (≤5%). ` +
        `Consider using 'medium' (0.5%) or 'high' (1%) preset.`,
    }
  }

  return null
}

// ─── Risk class 3: STALE_QUOTE ───────────────────────────────────────────────
// Blocks if fewer than 5 seconds remain on the quote TTL.
// A stale quote will fail on-chain with an expired signature.

export function checkStaleness(quote: RoutexQuote): RiskFlag | null {
  const remaining = quote.validUntil - Date.now()

  if (remaining < 5_000) {
    return {
      class: RiskClass.STALE_QUOTE,
      severity: 'block',
      message:
        `Quote expired or expiring in ${Math.max(0, Math.round(remaining / 1000))}s. ` +
        `Call getQuote again to refresh.`,
    }
  }

  if (remaining < 10_000) {
    return {
      class: RiskClass.STALE_QUOTE,
      severity: 'warn',
      message: `Quote expires in ${Math.round(remaining / 1000)}s — execute soon.`,
    }
  }

  return null
}

// ─── Risk class 4: THIN_LIQUIDITY ────────────────────────────────────────────
// Thin liquidity manifests as high price impact even on moderate trade sizes.
// We flag when impact exceeds 1% as a signal that the pool is shallow.
// This is distinct from HIGH_PRICE_IMPACT which enforces the user's threshold.

export function checkThinLiquidity(quote: RoutexQuote): RiskFlag | null {
  const impact = quote.priceImpact

  if (impact > 0.05) {
    return {
      class: RiskClass.THIN_LIQUIDITY,
      severity: 'warn',
      message:
        `Pool depth is shallow — your trade moves the price by ${(impact * 100).toFixed(2)}%. ` +
        `Consider splitting into smaller trades or checking liquidity on-chain.`,
    }
  }

  if (impact > 0.01) {
    return {
      class: RiskClass.THIN_LIQUIDITY,
      severity: 'info',
      message:
        `Moderate liquidity depth detected (${(impact * 100).toFixed(2)}% impact). ` +
        `Trade will execute but you may get a slightly better rate with a smaller amount.`,
    }
  }

  return null
}

// ─── Risk class 5: INSUFFICIENT_GAS ─────────────────────────────────────────
// Checks that the sender's SUI balance covers gas + sell amount (if selling SUI).
// Falls back to info-only when balance cannot be fetched.

export async function checkGas(
  intent: VektorIntent,
  quote: RoutexQuote,
  senderAddress: string,
  suiClient: any,
): Promise<RiskFlag | null> {
  try {
    const balance = await suiClient.getBalance({
      owner: senderAddress,
      coinType: '0x2::sui::SUI',
    })
    const suiBalance = BigInt(balance.totalBalance)

    // Required: gas + amount if selling SUI
    const gasBuffer = quote.gasEstimate * 2n  // 2× safety margin
    const sellingSui = intent.from === 'SUI'
    const required = sellingSui
      ? intent.amountIn + gasBuffer
      : gasBuffer

    if (suiBalance < required) {
      const shortfall = Number(required - suiBalance) / SUI_SCALAR
      return {
        class: RiskClass.INSUFFICIENT_GAS,
        severity: 'block',
        message:
          `Insufficient SUI balance. Need ~${(Number(required) / SUI_SCALAR).toFixed(4)} SUI ` +
          `(trade + gas), but wallet holds ${(Number(suiBalance) / SUI_SCALAR).toFixed(4)} SUI. ` +
          `Shortfall: ${shortfall.toFixed(4)} SUI.`,
      }
    }

    // Warn if gas buffer is tight (balance < 2× required)
    if (suiBalance < required * 2n) {
      return {
        class: RiskClass.INSUFFICIENT_GAS,
        severity: 'info',
        message: `SUI balance is sufficient but tight. Consider keeping extra for gas.`,
      }
    }

    return null
  } catch {
    // Cannot fetch balance — skip this check rather than false-blocking
    return null
  }
}

// ─── Risk class 6: PROTOCOL_CONCENTRATION ────────────────────────────────────
// Warns when 100% of liquidity flows through a single protocol that is not
// a battle-tested CLOB (DeepBook). AMMs carry smart contract risk.

export function checkProtocolConcentration(quote: RoutexQuote): RiskFlag | null {
  const protocols = new Set(quote.route.map(s => s.protocol))

  if (protocols.size === 1) {
    const [protocol] = protocols
    // DeepBook is a Mysten Labs CLOB — considered lowest smart-contract risk
    if (protocol !== 'deepbook') {
      return {
        class: RiskClass.PROTOCOL_CONCENTRATION,
        severity: 'info',
        message:
          `100% of this route flows through ${protocol}. ` +
          `All AMMs carry smart contract risk — ensure you understand the protocol.`,
      }
    }
  }

  return null
}

// ─── Risk class 7: LARGE_TRADE ───────────────────────────────────────────────
// Warns when the USD-equivalent trade size exceeds LARGE_TRADE_USD_THRESHOLD.
// Does not block — large traders may intentionally trade large sizes.

export function checkLargeTrade(intent: VektorIntent): RiskFlag | null {
  // Only estimate when selling SUI (known USD price proxy)
  if (intent.from !== 'SUI') return null

  const suiAmount = Number(intent.amountIn) / SUI_SCALAR
  const usdEstimate = suiAmount * APPROX_SUI_USD

  if (usdEstimate >= LARGE_TRADE_USD_THRESHOLD) {
    return {
      class: RiskClass.LARGE_TRADE,
      severity: 'warn',
      message:
        `Trade size is ~$${usdEstimate.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD. ` +
        `Large trades have higher price impact and may be front-run. ` +
        `Consider splitting into multiple smaller trades.`,
    }
  }

  return null
}
