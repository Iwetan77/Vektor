import { runGuardian, stripQuoteForJson, type GuardianReportV2 } from './v2.js'

const SIM_ADDR = '0x0000000000000000000000000000000000000000000000000000000000000001'

/**
 * Rewrite the PTB based on Guardian flags.
 * Calls Routex with modified params (exclude bad protocols, split trade, etc.)
 * and re-runs the Guardian on the new quote.
 */
export async function rewritePTB(
  report:        GuardianReportV2,
  walletAddress: string,
  network:       'mainnet' | 'testnet' = 'mainnet',
): Promise<GuardianReportV2> {
  const original = report.originalQuote
  // Lazy-load Routex to avoid Vercel startup crash (cetus-sdk CJS requires ESM @mysten/sui)
  const { default: RoutexClass } = await import('routex-sui')
  const routex   = new (RoutexClass as any)(network, walletAddress || SIM_ADDR)

  // originalQuote may come back from the client with different shapes depending
  // on whether BigInt fields survived JSON round-trip.  Normalise defensively.
  const fromSym  = original.fromSymbol ?? original.from?.symbol ?? 'SUI'
  const toSym    = original.toSymbol   ?? original.to?.symbol   ?? 'USDC'
  const slippage = original.slippageTolerance ?? 0.005
  const rawIn    = original.amountIn ?? '0'
  const amountIn = typeof rawIn === 'bigint' ? rawIn : BigInt(String(rawIn))

  for (const flag of report.flags) {
    if (flag.severity === 'green') continue

    switch (flag.suggestion) {
      case 'split_trade': {
        const halfAmount = amountIn / 2n || 1n
        const [q1, q2]  = await Promise.all([
          routex.getQuote({ from: fromSym, to: toSym, amount: halfAmount, slippageTolerance: slippage }),
          routex.getQuote({ from: fromSym, to: toSym, amount: halfAmount, slippageTolerance: slippage }),
        ])
        const merged = {
          ...q1,
          amountOut:   q1.amountOut + q2.amountOut,
          priceImpact: Math.max(q1.priceImpact, q2.priceImpact) * 0.6,
          _split: true,
        }
        const newReport = await runGuardian(merged, walletAddress, null)
        return { ...newReport, rewrittenQuote: stripQuoteForJson(merged) }
      }

      case 'reroute': {
        const flaggedProtocol = original.route?.find((s: any) =>
          flag.message.toLowerCase().includes(s.protocol?.toLowerCase() ?? '')
        )?.protocol

        try {
          const newQuote = await routex.getQuote({
            from:              fromSym,
            to:                toSym,
            amount:            amountIn,
            slippageTolerance: slippage,
            ...(flaggedProtocol ? { excludeProtocols: [flaggedProtocol] } : {}),
          })
          const newReport = await runGuardian(newQuote, walletAddress, null)
          return { ...newReport, rewrittenQuote: stripQuoteForJson(newQuote) }
        } catch (err: any) {
          if (err?.message?.includes('No route found') || err?.message?.includes('timed out')) {
            // Only one viable path exists — fall through to return original report
            break
          }
          throw err
        }
      }

      case 'rebuild': {
        const newQuote = await routex.getQuote({
          from:              fromSym,
          to:                toSym,
          amount:            amountIn,
          slippageTolerance: slippage,
        })
        const newReport = await runGuardian(newQuote, walletAddress, null)
        return { ...newReport, rewrittenQuote: stripQuoteForJson(newQuote) }
      }
    }
  }

  // No suggestions — return a re-evaluated fresh quote (originalQuote is already stripped)
  return { ...report, rewrittenQuote: original }
}
