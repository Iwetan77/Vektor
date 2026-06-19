/**
 * SwapQuoteCard — rich rendering of a Routex swap quote.
 *
 * Consumes the serialized quote produced by `serializeQuote()` in src/server.ts
 * (surfaced by /api/ptb and /api/intent). Fields used, verbatim from that shape:
 *   amountInFormatted, amountOutFormatted, fromSymbol, toSymbol,
 *   route[].protocol, priceImpact (fraction, ×100 = %), gasEstimateFormatted,
 *   _raw.slippageTolerance.
 * Every field has a graceful fallback — never renders `undefined`.
 */
import { Fragment } from 'react'

interface SwapQuoteCardProps {
  quote:         any
  parsedIntent?: any
}

/** Price-impact color: green <0.5%, amber <2%, red ≥2% (input is percent). */
function impactColor(pct: number): string {
  if (pct < 0.5) return 'text-emerald-400'
  if (pct < 2)   return 'text-amber-400'
  return 'text-red-400'
}

function Arrow() {
  return (
    <svg className="w-3.5 h-3.5 text-slate-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

function TokenNode({ sym, amount }: { sym: string; amount: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 shrink-0">
      <span className="text-sm font-semibold text-white leading-none">{sym}</span>
      {amount !== '—' && <span className="text-[10px] font-mono text-slate-400 leading-none">{amount}</span>}
    </div>
  )
}

function DexPill({ label }: { label: string }) {
  return (
    <span className="text-[11px] font-medium px-2 py-1 rounded-md bg-white/[0.04] text-indigo-300 shrink-0 capitalize">
      {label}
    </span>
  )
}

export function SwapQuoteCard({ quote, parsedIntent }: SwapQuoteCardProps) {
  const from      = String(quote?.fromSymbol ?? parsedIntent?.input_asset ?? '—').toUpperCase()
  const to        = String(quote?.toSymbol   ?? parsedIntent?.output_goal ?? '—').toUpperCase()
  const amountIn  = quote?.amountInFormatted  ?? '—'
  const amountOut = quote?.amountOutFormatted ?? '—'

  const protocols: string[] = Array.isArray(quote?.route)
    ? quote.route.map((h: any) => h?.protocol).filter(Boolean)
    : []

  const impactPct = (typeof quote?.priceImpact === 'number' ? quote.priceImpact : 0) * 100
  const slippage  = quote?._raw?.slippageTolerance ?? parsedIntent?.constraints?.max_slippage ?? 0.005
  const gas       = quote?.gasEstimateFormatted ?? '—'

  const expectedOut = parseFloat(amountOut)
  const minOut = Number.isFinite(expectedOut) && expectedOut > 0
    ? (expectedOut * (1 - slippage)).toFixed(to === 'SUI' ? 4 : 6)
    : '—'

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-5 space-y-5">
      {/* Header: From → To */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">Swap Quote</h2>
        <span className="text-xs font-mono text-slate-500">{from} → {to}</span>
      </div>

      {/* Amounts */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">You pay</p>
          <p className="text-lg font-bold text-white tabular-nums">{amountIn} <span className="text-sm font-normal text-slate-400">{from}</span></p>
        </div>
        <Arrow />
        <div className="space-y-0.5 text-right">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">You receive</p>
          <p className="text-lg font-bold text-white tabular-nums">{amountOut} <span className="text-sm font-normal text-slate-400">{to}</span></p>
        </div>
      </div>

      {/* Route diagram */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-slate-600">Route</p>
        <div className="flex items-center gap-2 flex-wrap">
          <TokenNode sym={from} amount={amountIn} />
          {protocols.length === 0 ? (
            <><Arrow /><DexPill label="Direct" /></>
          ) : (
            protocols.map((p, i) => (
              <Fragment key={i}><Arrow /><DexPill label={p} /></Fragment>
            ))
          )}
          <Arrow />
          <TokenNode sym={to} amount={amountOut} />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-3 pt-1 border-t border-white/5">
        <div className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">Price impact</p>
          <p className={`text-sm font-semibold tabular-nums ${impactColor(impactPct)}`}>{impactPct.toFixed(2)}%</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">Min. received</p>
          <p className="text-sm font-semibold text-slate-300 tabular-nums">~{minOut}</p>
          <p className="text-[10px] text-slate-600">{(slippage * 100).toFixed(1)}% slippage</p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">Est. gas</p>
          <p className="text-sm font-semibold text-slate-300 tabular-nums font-mono">~{gas} SUI</p>
        </div>
      </div>
    </div>
  )
}
