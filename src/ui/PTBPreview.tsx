interface Props {
  parsedIntent: any
  quote:        any
  originalText: string
}

const STEP_LABELS: Record<string, string> = {
  swap_sui_usdc:   'Swap SUI → USDC via best route',
  swap_sui_usdt:   'Swap SUI → USDT via best route',
  swap_usdc_sui:   'Swap USDC → SUI via best route',
  deposit_navi:    'Deposit into NAVI lending pool',
  deposit_scallop: 'Deposit into Scallop lending pool',
}

export function PTBPreview({ parsedIntent, quote, originalText }: Props) {
  // Minimum guaranteed = expected output × (1 − slippage tolerance)
  // Use the already-formatted decimal value — never touch the raw base-unit integer
  const slippage   = parsedIntent.constraints?.max_slippage ?? 0.005
  const expectedOut = parseFloat(quote.amountOutFormatted ?? '0')
  const decimals   = quote.toSymbol === 'SUI' ? 4 : 6
  const minOut     = expectedOut > 0
    ? (expectedOut * (1 - slippage)).toFixed(decimals)
    : '—'

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#111118] p-6 space-y-5">
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">PTB Preview</h2>

      {/* Original intent */}
      <div className="space-y-1">
        <p className="text-xs text-slate-600">You said</p>
        <p className="text-sm text-slate-300 italic">"{originalText}"</p>
      </div>

      {/* Parsed intent */}
      <div className="rounded-lg bg-slate-900/60 border border-[#1e1e2e] px-4 py-3 space-y-2">
        <p className="text-xs text-slate-500 uppercase tracking-wider">Vektor will</p>
        {(parsedIntent.inferred_steps ?? [`swap_${parsedIntent.input_asset?.toLowerCase()}_${parsedIntent.output_goal?.toLowerCase()}`]).map((step: string, i: number) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 text-xs flex items-center justify-center font-mono shrink-0">
              {i + 1}
            </span>
            <span className="text-sm text-white">{STEP_LABELS[step] ?? step.replace(/_/g, ' ')}</span>
          </div>
        ))}
      </div>

      {/* Route */}
      <div className="space-y-2">
        <p className="text-xs text-slate-600">Route</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-semibold text-white">{parsedIntent.input_asset}</span>
          {(quote.route ?? []).map((hop: any, i: number) => (
            <span key={i} className="flex items-center gap-1.5">
              <span className="text-slate-600 text-xs">→</span>
              <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-800 text-indigo-300 border border-slate-700">
                {hop.protocol}
              </span>
            </span>
          ))}
          <span className="text-slate-600 text-xs">→</span>
          <span className="text-sm font-semibold text-white">{parsedIntent.output_goal?.toUpperCase()}</span>
        </div>
      </div>

      {/* Outcome */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-lg bg-slate-900/60 border border-[#1e1e2e] p-4 space-y-1">
          <p className="text-xs text-slate-500">Expected output</p>
          <p className="text-lg font-bold text-white tabular-nums">
            {quote.amountOutFormatted}
            <span className="text-sm font-normal text-slate-400 ml-1">{parsedIntent.output_goal?.toUpperCase()}</span>
          </p>
        </div>
        <div className="rounded-lg bg-slate-900/60 border border-[#1e1e2e] p-4 space-y-1">
          <p className="text-xs text-slate-500">Minimum guaranteed</p>
          <p className="text-base font-semibold text-slate-300 tabular-nums">
            ~{minOut}
            <span className="text-sm font-normal text-slate-500 ml-1">{parsedIntent.output_goal?.toUpperCase()}</span>
          </p>
          <p className="text-xs text-slate-600">{(slippage * 100).toFixed(1)}% slippage</p>
        </div>
      </div>

      {/* Gas */}
      <div className="flex items-center justify-between text-xs text-slate-500 pt-1 border-t border-[#1e1e2e]">
        <span>Estimated gas</span>
        <span className="text-slate-400 font-mono">~{quote.gasEstimateFormatted} SUI</span>
      </div>
    </div>
  )
}
