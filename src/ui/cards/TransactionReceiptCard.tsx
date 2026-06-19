/**
 * TransactionReceiptCard — result of a single completed execution.
 *
 * The browser holds the digest (VektorResult.digest) plus the originating
 * payload after signing; this card renders that. Optional fields degrade
 * gracefully — a missing from/to or timestamp is simply omitted, never
 * rendered as `undefined`.
 */
interface TransactionReceiptCardProps {
  digest:      string
  title:       string
  /** Human label for what left the wallet, e.g. "0.5 SUI". */
  fromLabel?:  string
  /** Human label for what arrived / the destination, e.g. "12.3 USDC", "ivan.sui", "NAVI". */
  toLabel?:    string
  executedAt?: number
  /** On-chain VektorLog confirmation, if the deploy recorded one. */
  vektorLog?:  string
}

function Arrow() {
  return (
    <svg className="w-3.5 h-3.5 text-slate-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

export function TransactionReceiptCard({ digest, title, fromLabel, toLabel, executedAt, vektorLog }: TransactionReceiptCardProps) {
  const shortDigest = digest ? `${digest.slice(0, 12)}…${digest.slice(-6)}` : '—'
  const when = executedAt ? new Date(executedAt).toLocaleString() : null

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-6 py-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-emerald-400 text-lg leading-none">✓</span>
        <span className="text-white font-semibold text-sm">{title}</span>
      </div>

      {fromLabel && toLabel && (
        <div className="flex items-center gap-2.5 text-sm">
          <span className="font-semibold text-white tabular-nums">{fromLabel}</span>
          <Arrow />
          <span className="font-semibold text-white tabular-nums">{toLabel}</span>
        </div>
      )}

      <div className="flex items-center gap-2 font-mono text-xs text-slate-400">
        <span>Digest</span>
        <span className="text-slate-300">{shortDigest}</span>
        <a
          href={`https://suiscan.xyz/mainnet/tx/${digest}`}
          target="_blank"
          rel="noreferrer"
          className="text-purple-400 hover:text-purple-300 transition-colors"
        >
          ↗ Suiscan
        </a>
      </div>

      {when && <p className="text-[11px] text-slate-600">{when}</p>}

      {vektorLog && (
        <p className="text-[11px] text-emerald-300/70 font-mono">⛓ VektorLog: {vektorLog}</p>
      )}
    </div>
  )
}
