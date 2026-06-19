interface RiskFlag {
  class:       number
  severity:    'green' | 'yellow' | 'red'
  title:       string
  message:     string
  suggestion?: string
}

interface Report {
  score:            number
  level:            'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  flags:            RiskFlag[]
  canProceed:       boolean
  rewriteAvailable: boolean
}

interface RewriteDiff {
  before: { score: number; amountOut: string; priceImpact: number; route: string[] }
  after:  { score: number; amountOut: string; priceImpact: number; route: string[] }
}

interface Props {
  report:       Report
  rewriting:    boolean
  wasRewritten: boolean
  diff?:        RewriteDiff | null
  onFix:        () => void
}

const LEVEL_COLORS = {
  LOW:      { text: 'text-emerald-400', ring: '#22c55e', bg: 'bg-emerald-400/10 border-emerald-500/20', icon: '✅' },
  MEDIUM:   { text: 'text-amber-400',   ring: '#f59e0b', bg: 'bg-amber-400/10 border-amber-500/20',   icon: '⚠️' },
  HIGH:     { text: 'text-orange-400',  ring: '#f97316', bg: 'bg-orange-400/10 border-orange-500/20', icon: '🔶' },
  CRITICAL: { text: 'text-red-400',     ring: '#ef4444', bg: 'bg-red-400/10 border-red-500/20',       icon: '🚫' },
}

const SEV_ICON = { green: '✓', yellow: '⚠', red: '✗' }
const SEV_COLOR = {
  green:  'text-emerald-400',
  yellow: 'text-amber-400',
  red:    'text-red-400',
}
const SEV_BAR = {
  green:  'border-emerald-500/30',
  yellow: 'border-amber-500/30',
  red:    'border-red-500/30',
}

const CLASS_NAMES: Record<number, string> = {
  1: 'Slippage',
  2: 'Oracle',
  3: 'Ghost Pool',
  4: 'Price Impact',
  5: 'Concentration',
  6: 'Protocol Age',
  7: 'Gas Anomaly',
}

function ScoreRing({ score, level }: { score: number; level: keyof typeof LEVEL_COLORS }) {
  const colors = LEVEL_COLORS[level]
  const radius = 40
  const circ   = 2 * Math.PI * radius        // 251.3
  const dash   = (score / 100) * circ

  return (
    <div className="relative w-28 h-28 shrink-0">
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#1e1e2e" strokeWidth="8" />
        <circle
          cx="50" cy="50" r={radius} fill="none"
          stroke={colors.ring} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.8s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-2xl font-bold tabular-nums ${colors.text}`}>{score}</span>
        <span className="text-xs text-slate-500 font-mono">/100</span>
      </div>
    </div>
  )
}

export function GuardianReport({ report, rewriting, wasRewritten, diff, onFix }: Props) {
  const colors  = LEVEL_COLORS[report.level]
  const redFlags    = report.flags.filter(f => f.severity === 'red')
  const yellowFlags = report.flags.filter(f => f.severity === 'yellow')

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#111118] p-6 space-y-6">
      {/* Header line */}
      <div className="flex items-start gap-5">
        <ScoreRing score={report.score} level={report.level} />
        <div className="flex-1 space-y-2">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">Guardian Report</h2>
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-semibold ${colors.bg} ${colors.text}`}>
            {colors.icon} {report.level} RISK
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">
            {redFlags.length > 0    && `${redFlags.length} critical issue${redFlags.length > 1 ? 's' : ''} detected. `}
            {yellowFlags.length > 0 && `${yellowFlags.length} warning${yellowFlags.length > 1 ? 's' : ''} found. `}
            {redFlags.length === 0 && yellowFlags.length === 0 && 'All checks passed. '}
            {!report.canProceed && 'Execution blocked until issues are resolved.'}
          </p>
        </div>
      </div>

      {/* Separator */}
      <div className="border-t border-[#1e1e2e]" />

      {/* Flag list — matches lightpaper format */}
      <div className="space-y-2 font-mono text-sm">
        {report.flags.map((flag, i) => (
          <div key={i} className={`flex items-start gap-3 pl-3 border-l-2 py-1 ${SEV_BAR[flag.severity]}`}>
            <span className={`shrink-0 font-bold ${SEV_COLOR[flag.severity]}`}>{SEV_ICON[flag.severity]}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-400 text-xs">[{CLASS_NAMES[flag.class] ?? `RC${flag.class}`}]</span>
                <span className={`font-semibold ${SEV_COLOR[flag.severity]}`}>{flag.title}</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 leading-relaxed font-sans">{flag.message}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Separator */}
      <div className="border-t border-[#1e1e2e]" />

      {/* Action row */}
      <div className="flex items-center gap-3 flex-wrap">
        {report.rewriteAvailable && !wasRewritten && (
          <button
            onClick={onFix}
            disabled={rewriting}
            className="btn-fix flex items-center gap-2 px-5 py-2.5 rounded-lg text-black font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {rewriting ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                Rewriting PTB…
              </>
            ) : '⚡ FIX IT FOR ME'}
          </button>
        )}

        {wasRewritten && !diff && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <span className="text-emerald-400 text-sm font-semibold">✓ PTB rewritten</span>
            <span className="text-slate-500 text-xs">Guardian re-evaluated with optimized route</span>
          </div>
        )}

        {!report.canProceed && (
          <p className="text-xs text-red-400/70 ml-auto">Resolve critical issues to proceed</p>
        )}
      </div>

      {/* Feature 1: Before / After diff card */}
      {wasRewritten && diff && (
        <>
          <div className="border-t border-[#1e1e2e]" />
          <div className="space-y-2">
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Rewrite Comparison</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Before */}
              <div className="rounded-lg bg-red-500/5 border border-red-500/15 p-3 space-y-2">
                <p className="text-[9px] font-mono uppercase tracking-widest text-red-400">Before</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Score</span>
                    <span className="text-red-300 font-mono">{diff.before.score}/100</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Impact</span>
                    <span className="text-red-300 font-mono">{(diff.before.priceImpact * 100).toFixed(3)}%</span>
                  </div>
                  {diff.before.route.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Route</span>
                      <span className="text-slate-400 font-mono text-[10px]">{diff.before.route.join('→')}</span>
                    </div>
                  )}
                </div>
              </div>
              {/* After */}
              <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/15 p-3 space-y-2">
                <p className="text-[9px] font-mono uppercase tracking-widest text-emerald-400">After</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Score</span>
                    <span className="text-emerald-300 font-mono">{diff.after.score}/100</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Impact</span>
                    <span className="text-emerald-300 font-mono">{(diff.after.priceImpact * 100).toFixed(3)}%</span>
                  </div>
                  {diff.after.route.length > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Route</span>
                      <span className="text-slate-400 font-mono text-[10px]">{diff.after.route.join('→')}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {/* Delta badge */}
            {(() => {
              const delta = diff.after.score - diff.before.score
              return delta !== 0 ? (
                <p className={`text-xs text-center font-mono ${delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {delta > 0 ? `↑ Score improved by +${delta}` : `↓ Score changed by ${delta}`}
                </p>
              ) : null
            })()}
          </div>
        </>
      )}
    </div>
  )
}
