/**
 * BundleReceiptCard — result of a completed batch/split payment (many recipients,
 * one transaction). Renders from the batchData payload the UI already holds
 * (members[], amountPerPerson, token) plus the shared digest. Graceful fallbacks
 * throughout — never renders `undefined`.
 */
interface BundleRecipient {
  name?:    string
  address:  string
}

interface BundleReceiptCardProps {
  digest:          string
  token:           string
  amountPerPerson: number
  recipients:      BundleRecipient[]
  kind?:           'batch' | 'split'
}

function short(addr: string): string {
  if (!addr) return '—'
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr
}

// .toFixed(2) collapses small amounts (e.g. 0.0005) to "0.00", making a real
// payment look like it sent nothing. Fall back to more decimals when the
// 2-decimal rounding would otherwise hide a nonzero amount.
function fmtAmount(n: number): string {
  if (n === 0) return '0.00'
  if (Math.abs(n) >= 0.01) return n.toFixed(2)
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

export function BundleReceiptCard({ digest, token, amountPerPerson, recipients, kind = 'batch' }: BundleReceiptCardProps) {
  const list  = Array.isArray(recipients) ? recipients : []
  const count = list.length
  const per   = Number.isFinite(amountPerPerson) ? amountPerPerson : 0
  const total = per * count
  const sym   = token || ''
  const shortDigest = digest ? `${digest.slice(0, 12)}…${digest.slice(-6)}` : '—'

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-6 py-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-emerald-400 text-lg leading-none">✓</span>
        <span className="text-white font-semibold text-sm">
          {kind === 'split' ? 'Split' : 'Paid'} {count} recipient{count === 1 ? '' : 's'} · {fmtAmount(total)} {sym} total
        </span>
      </div>

      <div className="space-y-1.5">
        {list.map((r, i) => (
          <div key={r.address || i} className="flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-emerald-400 shrink-0">✓</span>
              <span className="text-slate-300 truncate">{r.name || short(r.address)}</span>
              {r.name && <span className="text-slate-600 font-mono shrink-0">{short(r.address)}</span>}
            </div>
            <span className="text-white font-mono tabular-nums shrink-0">{fmtAmount(per)} {sym}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 font-mono text-xs text-slate-400 pt-1 border-t border-white/5">
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
    </div>
  )
}
