/**
 * EchoPage — /echo route inside Vektor.
 * Autonomous DeFi management: Basic (watch) → Medium (propose) → High (execute).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useCurrentAccount }                        from '@mysten/dapp-kit'
import { EchoOrb }                                  from './EchoOrb.js'
import type {
  EchoUserData, EchoRule,
  WatchCondition, ScheduledIntent, MonitoredPosition,
  EchoActivity, EchoScore, EchoWsMessage,
} from '../echo/types.js'

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function Spinner({ size = 4 }: { size?: number }) {
  return (
    <svg className={`w-${size} h-${size} animate-spin shrink-0`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-block text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded ${color}`}>
      {label}
    </span>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="text-xs text-slate-600 text-center py-8">{label}</p>
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000)    return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ms).toLocaleDateString()
}

function countdown(ms: number): string {
  const diff = ms - Date.now()
  if (diff <= 0) return 'now'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  const d = Math.floor(diff / 86_400_000)
  if (d > 0) return `in ${d}d ${h % 24}h`
  if (h > 0) return `in ${h}h ${m}m`
  return `in ${m}m`
}

const ACTION_COLORS: Record<EchoActivity['action'], string> = {
  alert:    'bg-yellow-500/10 text-yellow-400',
  proposal: 'bg-blue-500/10 text-blue-400',
  executed: 'bg-emerald-500/10 text-emerald-400',
  blocked:  'bg-red-500/10 text-red-400',
}

/* ─── Sub-panels ──────────────────────────────────────────────────────── */

function WatchingPanel({ conditions }: { conditions: WatchCondition[] }) {
  return (
    <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-4 space-y-3">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Watching</p>
      {conditions.length === 0
        ? <Empty label='No conditions. Add a rule like "Swap SUI to USDC if SUI drops below $3".' />
        : conditions.map(c => {
          const dist  = c.triggerPrice > 0
            ? Math.abs((c.currentPrice - c.triggerPrice) / c.triggerPrice * 100)
            : null
          const near  = dist != null && dist < 5
          return (
            <div key={c.id} className="rounded-lg bg-[#111118] border border-white/5 p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-white leading-snug">{c.raw}</p>
                <Badge label={c.direction === 'below' ? '↓' : '↑'} color={near ? 'bg-yellow-500/20 text-yellow-300' : 'bg-slate-500/10 text-slate-400'} />
              </div>
              <div className="flex items-center gap-4 text-[10px] text-slate-500">
                <span className="font-mono">{c.asset} ${c.currentPrice.toFixed(4)}</span>
                <span>→ trigger ${c.triggerPrice}</span>
                {dist != null && (
                  <span className={near ? 'text-yellow-400 font-semibold' : ''}>
                    {dist.toFixed(1)}% away
                  </span>
                )}
              </div>
            </div>
          )
        })
      }
    </div>
  )
}

function ScheduledPanel({ scheduled }: { scheduled: ScheduledIntent[] }) {
  return (
    <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-4 space-y-3">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Scheduled</p>
      {scheduled.length === 0
        ? <Empty label='No scheduled intents. Try "DCA 10 USDC into SUI daily for 30 days".' />
        : scheduled.map(s => {
          const pct = s.executionsRemaining + s.totalExecuted > 0
            ? (s.totalExecuted / (s.executionsRemaining + s.totalExecuted)) * 100
            : 0
          return (
            <div key={s.id} className="rounded-lg bg-[#111118] border border-white/5 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-white leading-snug">{s.raw}</p>
                <Badge label={s.frequency} color="bg-blue-500/10 text-blue-400" />
              </div>
              <div className="flex items-center gap-4 text-[10px] text-slate-500">
                <span>Next: <span className="text-slate-300">{countdown(s.nextExecution)}</span></span>
                <span>{s.totalExecuted} of {s.totalExecuted + s.executionsRemaining} done</span>
              </div>
              <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500/50 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })
      }
    </div>
  )
}

function PositionsPanel({ positions }: { positions: MonitoredPosition[] }) {
  return (
    <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-4 space-y-3">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Positions</p>
      {positions.length === 0
        ? <Empty label='No monitored positions. Buy a token and set a stop-loss or profit target.' />
        : positions.map(p => {
          const pnlPct  = p.entryPrice > 0 ? (p.currentPrice - p.entryPrice) / p.entryPrice : 0
          const pnlUsd  = pnlPct * p.amount * p.entryPrice
          const positive = pnlPct >= 0
          return (
            <div key={p.id} className="rounded-lg bg-[#111118] border border-white/5 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white">{p.token}</span>
                <span className={`text-xs font-mono font-bold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
                  {positive ? '+' : ''}{(pnlPct * 100).toFixed(2)}% (${pnlUsd.toFixed(2)})
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-500">
                <span>Entry: <span className="text-slate-300 font-mono">${p.entryPrice.toFixed(4)}</span></span>
                <span>Now: <span className="text-slate-300 font-mono">${p.currentPrice.toFixed(4)}</span></span>
                {p.stopLoss && <span>Stop: <span className="text-red-400 font-mono">${p.stopLoss.toFixed(4)}</span></span>}
                {p.profitTarget && <span>Target: <span className="text-emerald-400 font-mono">${p.profitTarget.toFixed(4)}</span></span>}
              </div>
            </div>
          )
        })
      }
    </div>
  )
}

function ActivityPanel({ log }: { log: EchoActivity[] }) {
  return (
    <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-4 space-y-2">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Activity</p>
      {log.length === 0
        ? <Empty label="No activity yet. Echo will log every alert, proposal, and execution here." />
        : log.slice(0, 20).map(a => (
          <div key={a.id} className="flex items-start gap-3 py-2 border-b border-white/5 last:border-0">
            <Badge label={a.action} color={ACTION_COLORS[a.action]} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-300 leading-snug">{a.description}</p>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-[9px] text-slate-600">{timeAgo(a.timestamp)}</span>
                {a.guardianScore != null && (
                  <span className="text-[9px] text-slate-600">Score {a.guardianScore}/100</span>
                )}
                {a.valueProtected != null && (
                  <span className="text-[9px] text-emerald-600">${a.valueProtected.toFixed(2)} protected</span>
                )}
                {a.digest && (
                  <a
                    href={`https://suiscan.xyz/testnet/tx/${a.digest}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[9px] text-purple-400 hover:text-purple-300"
                  >
                    ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        ))
      }
    </div>
  )
}

/* ─── Score display ───────────────────────────────────────────────────── */

function ScoreDetail({ score }: { score: EchoScore }) {
  const rows: { label: string; value: number; hint: string | null }[] = [
    { label: 'Diversification', value: score.diversification, hint: score.diversification < 20 ? 'One asset dominates your portfolio.' : null },
    { label: 'Yield Efficiency', value: score.yieldEfficiency, hint: score.yieldEfficiency < 20 ? 'Idle stablecoins not earning yield.' : null },
    { label: 'Debt Health',      value: score.debtHealth,      hint: score.debtHealth < 20 ? 'NAVI health factor is low.' : null },
    { label: 'Risk Exposure',    value: score.riskExposure,    hint: score.riskExposure < 20 ? 'High memecoin exposure.' : null },
  ]
  return (
    <div className="space-y-2">
      {rows.map(r => (
        <div key={r.label}>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-slate-400">{r.label}</span>
            <span className="text-white font-mono">{r.value}/25</span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                r.value >= 20 ? 'bg-emerald-500' : r.value >= 10 ? 'bg-yellow-500' : 'bg-red-500'
              }`}
              style={{ width: `${(r.value / 25) * 100}%` }}
            />
          </div>
          {r.hint && <p className="text-[10px] text-slate-600 mt-0.5">{r.hint}</p>}
        </div>
      ))}
    </div>
  )
}

/* ─── Rules Editor ────────────────────────────────────────────────────── */

const RULE_EXAMPLES = [
  'Never let my health factor drop below 1.5',
  'Always keep at least 100 USDC liquid',
  'Exit any memecoin down more than 25%',
  'Rebalance to 50/50 SUI and USDC when drift exceeds 10%',
]

function RulesEditor({
  wallet,
  rules,
  onRulesChange,
}: {
  wallet:        string
  rules:         EchoRule[]
  onRulesChange: (rules: EchoRule[]) => void
}) {
  const [input,          setInput]          = useState('')
  const [parsing,        setParsing]        = useState(false)
  const [preview,        setPreview]        = useState<{ interpretation: string; rule: EchoRule } | null>(null)
  const [err,            setErr]            = useState<string | null>(null)

  async function handleParse(e: React.FormEvent) {
    e.preventDefault()
    const raw = input.trim()
    if (!raw) return
    setErr(null); setParsing(true); setPreview(null)
    try {
      const res  = await fetch(`/api/echo/${wallet}/parse-rule`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ raw }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error)
      setPreview({
        interpretation: json.interpretation,
        rule: { id: crypto.randomUUID(), raw, parsed: json.parsed, active: true, autoExecute: false, createdAt: Date.now() },
      })
    } catch (e: any) {
      setErr(e.message ?? 'Failed to parse rule')
    } finally {
      setParsing(false)
    }
  }

  async function handleConfirm() {
    if (!preview) return
    setParsing(true)
    try {
      const res  = await fetch(`/api/echo/${wallet}/rules`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ raw: preview.rule.raw }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error)
      onRulesChange([...rules, json.rule])
      setInput(''); setPreview(null)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to save rule')
    } finally {
      setParsing(false)
    }
  }

  async function handleDeleteRule(id: string) {
    await fetch(`/api/echo/${wallet}/rules/${id}`, { method: 'DELETE' })
    onRulesChange(rules.filter(r => r.id !== id))
  }

  return (
    <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-5 space-y-4">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Rules Editor</p>

      {/* Active rules as chips */}
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {rules.map(r => (
            <div key={r.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-xs text-purple-300">
              <span className="truncate max-w-[200px]">{r.raw}</span>
              <button
                onClick={() => handleDeleteRule(r.id)}
                className="text-slate-600 hover:text-red-400 transition-colors shrink-0 ml-1"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleParse} className="space-y-3">
        <textarea
          value={input}
          onChange={e => { setInput(e.target.value); setPreview(null); setErr(null) }}
          placeholder={`Write a rule for Echo…\n\n${RULE_EXAMPLES[Math.floor(Date.now() / 10000) % RULE_EXAMPLES.length]}`}
          rows={3}
          className="w-full bg-[#111118] border border-white/8 rounded-xl px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500/25 resize-none leading-relaxed"
        />
        {err && <p className="text-xs text-red-400">{err}</p>}
        <button
          type="submit"
          disabled={!input.trim() || parsing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 text-purple-300 text-xs font-semibold transition-colors disabled:opacity-30"
        >
          {parsing && <Spinner />}
          {parsing ? 'Parsing…' : 'Parse Rule'}
        </button>
      </form>

      {/* Preview + confirm */}
      {preview && (
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
          <p className="text-xs text-slate-300 leading-relaxed">{preview.interpretation}</p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={parsing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 text-purple-200 text-xs font-semibold transition-colors disabled:opacity-40"
            >
              {parsing && <Spinner />}
              Confirm Rule
            </button>
            <button
              onClick={() => setPreview(null)}
              className="px-4 py-2 text-xs text-slate-500 hover:text-slate-300"
            >
              Edit
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Session key panel ───────────────────────────────────────────────── */

function SessionKeyPanel({
  wallet,
  metadata,
  packageId,
  onRevoke,
}: {
  wallet:    string
  metadata?: { authObjectId: string; expiresAt: number; maxAmountPerTx: number; maxAmountPerDay: number }
  packageId: string
  onRevoke:  () => void
}) {
  const [revoking, setRevoking] = useState(false)

  async function handleRevoke() {
    setRevoking(true)
    try {
      await fetch(`/api/echo/${wallet}/session-key`, { method: 'DELETE' })
      onRevoke()
    } finally {
      setRevoking(false)
    }
  }

  if (!metadata) return (
    <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-xs text-yellow-300">
      No session key active — autonomous rules (autoExecute) require a session key.
      <br/>
      <span className="text-slate-500 text-[10px]">Session key creation requires signing a transaction in your wallet.</span>
    </div>
  )

  const remaining  = Math.max(0, metadata.expiresAt - Date.now())
  const totalMs    = 7 * 24 * 60 * 60 * 1000
  const pct        = Math.min(100, (remaining / totalMs) * 100)
  const expiresStr = new Date(metadata.expiresAt).toLocaleDateString()

  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-white font-medium">Session key active</p>
          <p className="text-[10px] text-slate-500">Until {expiresStr} · {countdown(metadata.expiresAt)} remaining</p>
        </div>
        <button
          onClick={handleRevoke}
          disabled={revoking}
          className="text-[10px] text-red-400 hover:text-red-300 transition-colors"
        >
          {revoking ? 'Revoking…' : 'Revoke'}
        </button>
      </div>
      <div className="h-1 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500/50 rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/* ─── Main EchoPage ───────────────────────────────────────────────────── */

interface EchoPageProps {
  wsAlerts: EchoWsMessage[]
}

export default function EchoPage({ wsAlerts }: EchoPageProps) {
  const account = useCurrentAccount()
  const wallet  = account?.address ?? null

  const [data,       setData]       = useState<EchoUserData | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState<string | null>(null)
  const [hasAlert,   setHasAlert]   = useState(false)

  // Echo worker package ID (from env or hardcoded after deployment)
  const packageId = (import.meta as any).env?.VITE_ECHO_PACKAGE_ID ?? ''

  // Load Echo data
  const loadData = useCallback(async () => {
    if (!wallet) return
    setLoading(true); setErr(null)
    try {
      const res  = await fetch(`/api/echo/${wallet}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error)
      setData(json.data)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load Echo data')
    } finally {
      setLoading(false)
    }
  }, [wallet])

  useEffect(() => { loadData() }, [loadData])

  // Show alert glow when new WS alerts arrive
  useEffect(() => {
    if (wsAlerts.length === 0) return
    setHasAlert(true)
    const t = setTimeout(() => setHasAlert(false), 8000)
    return () => clearTimeout(t)
  }, [wsAlerts])

  if (!wallet) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-slate-500 text-sm">Connect your wallet to use Echo.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size={6} />
      </div>
    )
  }

  if (err || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-red-400 text-sm">{err ?? 'Failed to load Echo.'}</p>
          <button onClick={loadData} className="text-xs text-purple-400 hover:text-purple-300">Retry</button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">

        {/* ── Top section: orb + mode + score ─────────────────────────── */}
        <div className="flex flex-col items-center gap-6">
          <EchoOrb
            alert={hasAlert}
            score={data.echoScore.total}
            size={160}
          />

          <div className="text-center space-y-1">
            <p className="text-white font-semibold tracking-tight">Vektor Echo</p>
            <p className="text-xs text-slate-500">Watches your portfolio. Rules with autoExecute run autonomously within session limits.</p>
          </div>

          {/* Session key status */}
          <div className="w-full max-w-md">
            <SessionKeyPanel
              wallet={wallet}
              metadata={data.sessionKeyMetadata as any}
              packageId={packageId}
              onRevoke={loadData}
            />
          </div>
        </div>

        {/* ── Score breakdown ──────────────────────────────────────────── */}
        <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Echo Score</p>
            <span className="text-2xl font-bold text-white font-mono">{data.echoScore.total}<span className="text-slate-600 text-sm">/100</span></span>
          </div>
          <ScoreDetail score={data.echoScore} />
          {data.echoScore.lastCalculated > 0 && (
            <p className="text-[10px] text-slate-700">Last calculated {timeAgo(data.echoScore.lastCalculated)}</p>
          )}
        </div>

        {/* ── Live alerts from WebSocket ───────────────────────────────── */}
        {wsAlerts.length > 0 && (
          <div className="space-y-2">
            {wsAlerts.slice(-3).map((msg, i) => (
              <div key={i} className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 flex items-start gap-3">
                <span className="text-yellow-400 shrink-0 mt-0.5">◉</span>
                <div>
                  {'message' in msg && <p className="text-sm text-yellow-200">{msg.message}</p>}
                  {'description' in msg && <p className="text-sm text-emerald-200">{(msg as any).description}</p>}
                  <p className="text-[10px] text-slate-600 mt-0.5">{timeAgo(msg.timestamp)}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Four panels 2×2 ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <WatchingPanel  conditions={data.conditions} />
          <ScheduledPanel scheduled={data.scheduledIntents} />
          <PositionsPanel positions={data.positions} />
          <ActivityPanel  log={data.activityLog} />
        </div>

        {/* ── Rules editor ─────────────────────────────────────────────── */}
        <RulesEditor
          wallet={wallet}
          rules={data.rules}
          onRulesChange={(rules: EchoRule[]) => setData((prev: EchoUserData | null) => prev ? { ...prev, rules } : prev)}
        />

        <p className="text-center text-[10px] text-slate-700 pb-4">
          Echo · Walrus storage · Cloudflare Worker
        </p>
      </div>
    </div>
  )
}
