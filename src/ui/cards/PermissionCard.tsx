/**
 * PermissionCard — typed presentation for the confirmation step.
 *
 * Purely presentational: it owns no gate logic. ConfirmationGate computes the
 * risk state (blocked / acknowledged / disabled), passes it in, and PermissionCard
 * renders the action summary, color-coded Guardian score, the top 1–2 risk
 * findings, the cost, and the Cancel / Confirm & Sign buttons wired to the
 * gate's existing callbacks.
 */
import type { ReactNode } from 'react'

export interface PermissionFinding {
  title:    string
  severity: string
  message?: string
}

export interface PermissionCardProps {
  title:           string
  summary:         ReactNode
  level:           string          // LOW | MEDIUM | HIGH | CRITICAL
  score:           number          // 0–100
  routeLabel?:     string
  gasLabel?:       string          // e.g. "~0.04 SUI"
  findings:        PermissionFinding[]
  blocked:         boolean
  blockedMsg:      string
  needsAck:        boolean
  acknowledged:    boolean
  onToggleAck:     () => void
  confirmDisabled: boolean
  busy?:           boolean
  labels:          { confirm: string; cancel: string; ack: string; hint: string; busy: string }
  onConfirm:       () => void
  onCancel:        () => void
}

const LEVEL_EMOJI: Record<string, string> = { LOW: '✅', MEDIUM: '⚠️', HIGH: '🔶', CRITICAL: '🚫' }
const LEVEL_BADGE: Record<string, string> = {
  LOW:      'text-emerald-400 border-emerald-500/30 bg-emerald-500/5',
  MEDIUM:   'text-amber-400   border-amber-500/30   bg-amber-500/5',
  HIGH:     'text-orange-400  border-orange-500/30  bg-orange-500/5',
  CRITICAL: 'text-red-400     border-red-500/30     bg-red-500/5',
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400'
  if (score >= 50) return 'text-amber-400'
  return 'text-red-400'
}

function findingDot(severity: string): string {
  if (severity === 'green') return 'bg-emerald-400'
  if (severity === 'yellow' || severity === 'warn') return 'bg-amber-400'
  return 'bg-red-400'
}

export function PermissionCard(props: PermissionCardProps) {
  const {
    title, summary, level, score, routeLabel, gasLabel, findings,
    blocked, blockedMsg, needsAck, acknowledged, onToggleAck,
    confirmDisabled, busy, labels, onConfirm, onCancel,
  } = props

  return (
    <div className={`rounded-xl border p-6 space-y-5 ${blocked ? 'border-red-500/20 bg-red-500/5' : 'border-white/8 bg-white/[0.02]'}`}>
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">{title}</h2>

      {/* Summary + level badge */}
      <div className="rounded-lg bg-white/[0.03] border border-white/5 px-5 py-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-slate-300">{summary}</span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border shrink-0 ${LEVEL_BADGE[level] ?? ''}`}>
            {LEVEL_EMOJI[level] ?? ''} {level}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>Guardian score: <span className={`font-mono font-semibold ${scoreColor(score)}`}>{score}/100</span></span>
          {routeLabel && <span>Route: <span className="text-slate-300">{routeLabel}</span></span>}
          {gasLabel   && <span>Gas: <span className="text-slate-300 font-mono">{gasLabel}</span></span>}
        </div>
      </div>

      {/* Top risk findings */}
      {findings.length > 0 && (
        <div className="space-y-1.5">
          {findings.map((f, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${findingDot(f.severity)}`} />
              <span className="text-slate-300">
                <span className="font-medium text-white">{f.title}</span>
                {f.message ? ` — ${f.message}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Blocked banner */}
      {blocked && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {blockedMsg}
        </div>
      )}

      {/* Acknowledgment */}
      {!blocked && needsAck && (
        <label className="flex items-start gap-3 cursor-pointer group">
          <div
            onClick={onToggleAck}
            className={`mt-0.5 w-5 h-5 shrink-0 rounded border flex items-center justify-center transition-colors cursor-pointer ${
              acknowledged ? 'bg-indigo-600 border-indigo-500' : 'border-slate-600 group-hover:border-slate-400'
            }`}
          >
            {acknowledged && (
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
          <span className="text-sm text-slate-400">{labels.ack}</span>
        </label>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2.5 rounded-lg bg-white/[0.04] hover:bg-red-500/10 text-slate-300 hover:text-red-300 text-sm font-medium transition-colors"
        >
          {labels.cancel}
        </button>
        <button
          onClick={onConfirm}
          disabled={confirmDisabled}
          className="flex-1 py-2.5 rounded-lg btn-proceed text-white text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none transition-all flex items-center justify-center gap-2"
        >
          {busy ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="white" strokeWidth="4"/>
                <path className="opacity-75" fill="white" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
              </svg>
              {labels.busy}
            </>
          ) : labels.confirm}
        </button>
      </div>

      {!blocked && needsAck && !acknowledged && (
        <p className="text-xs text-slate-600 text-center">{labels.hint}</p>
      )}
    </div>
  )
}
