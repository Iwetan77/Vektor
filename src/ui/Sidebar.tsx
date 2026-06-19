/**
 * Sidebar — collapsible panel with Portfolio, History, Scheduled, Watching, Positions tabs.
 */

import { useState, useEffect, useRef } from 'react'

interface ScheduledItem {
  id:       string
  type:     string
  amount:   number
  token:    string
  targetToken?: string
  schedule: { frequency: string; nextRun: string; completedRuns: number; totalRuns: number }
}

interface ConditionItem {
  id:          string
  description: string
  trigger:     { type: string; asset: string; threshold: number }
}

interface Position {
  id:             string
  token:          string
  entryAmountUsd: number
  profitTarget?:  number
  stopLoss?:      number
  openedAt:       string
}

interface IntentRecord {
  id:        string
  type:      string
  summary:   string
  status:    'success' | 'pending' | 'failed'
  timestamp: string
}

interface Portfolio {
  totalUsd: number
  balances: Array<{ symbol: string; formatted: string; usdValue: number }>
  navi?:    { supplyBalances: Record<string, number>; borrowBalances: Record<string, number>; healthFactor: number | null }
}

interface SidebarProps {
  wallet:        string | null
  portfolio:     Portfolio | null
  onRefresh:     () => void
  mobileOpen?:   boolean   // controls slide-over visibility below md
  onMobileClose?: () => void
  // Mobile-only page switcher (chat / echo). Desktop has its own nav in the header.
  currentPage?:   'chat' | 'echo'
  onPageChange?:  (page: 'chat' | 'echo') => void
  echoAlertCount?: number
}

type Tab = 'portfolio' | 'history' | 'scheduled' | 'watching' | 'positions'

function Empty({ label }: { label: string }) {
  return <p className="text-xs text-slate-600 text-center py-8">{label}</p>
}

/* ── Token icon — uses real Sui SVG, color-coded letters for others ── */
const TOKEN_COLORS: Record<string, string> = {
  USDC:  'bg-blue-600/20 text-blue-400',
  USDT:  'bg-emerald-600/20 text-emerald-400',
  WETH:  'bg-cyan-600/20 text-cyan-400',
  WBTC:  'bg-orange-600/20 text-orange-400',
  DEEP:  'bg-indigo-600/20 text-indigo-400',
  haSUI: 'bg-sky-600/20 text-sky-400',
  vSUI:  'bg-violet-600/20 text-violet-400',
  BUCK:  'bg-yellow-600/20 text-yellow-400',
}

const TOKEN_LOGOS: Record<string, string> = {
  SUI:  '/sui.svg',
  USDC: '/usdc.svg',
}

function TokenIcon({ symbol }: { symbol: string }) {
  if (TOKEN_LOGOS[symbol]) {
    return <img src={TOKEN_LOGOS[symbol]} className="w-6 h-6 rounded-full" alt={symbol} />
  }
  const cls = TOKEN_COLORS[symbol] ?? 'bg-purple-600/20 text-purple-400'
  return (
    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${cls}`}>
      {symbol[0]}
    </span>
  )
}

/* ── Intent type badge colour ── */
function intentColor(type: string): string {
  if (['swap', 'rebalance', 'compound'].includes(type))               return 'text-purple-400'
  if (['lend', 'borrow', 'repay'].includes(type))                     return 'text-emerald-400'
  if (['dca', 'schedule'].includes(type))                             return 'text-blue-400'
  if (['buy_memecoin', 'sell_memecoin'].includes(type))               return 'text-yellow-400'
  if (['conditional', 'exit_at_profit', 'exit_at_loss'].includes(type)) return 'text-orange-400'
  return 'text-slate-400'
}

export function Sidebar({ wallet, portfolio, onRefresh, mobileOpen = false, onMobileClose, currentPage, onPageChange, echoAlertCount = 0 }: SidebarProps) {
  const [tab,        setTab]        = useState<Tab>('portfolio')
  const [open,       setOpen]       = useState(true)
  const [scheduled,  setScheduled]  = useState<ScheduledItem[]>([])
  const [conditions, setConditions] = useState<ConditionItem[]>([])
  const [positions,  setPositions]  = useState<Position[]>([])
  const [history,    setHistory]    = useState<IntentRecord[]>([])
  const [livePrices, setLivePrices] = useState<Record<string, number>>({})

  // Keep last known non-zero totalUsd to avoid $0.00 flicker during refresh
  const stableTotalRef = useRef<number | null>(null)
  if (portfolio && portfolio.totalUsd > 0) stableTotalRef.current = portfolio.totalUsd
  const displayTotal = stableTotalRef.current ?? (portfolio?.totalUsd ?? null)

  useEffect(() => {
    if (!wallet) return
    fetch(`/api/schedule/${wallet}`).then(r => r.json()).then(d => setScheduled(d.scheduled ?? [])).catch(() => {})
    fetch(`/api/conditions/${wallet}`).then(r => r.json()).then(d => setConditions(d.conditions ?? [])).catch(() => {})
  }, [wallet, tab])

  // Load intent history from memory API
  useEffect(() => {
    if (!wallet) { setHistory([]); return }
    fetch(`/api/memory/${wallet}`)
      .then(r => r.json())
      .then(d => setHistory(d.memory?.intentHistory ?? []))
      .catch(() => {})
  }, [wallet, tab])

  // Feature 2: Live PnL — poll /api/prices every 30s when on Positions tab
  useEffect(() => {
    if (tab !== 'positions') return
    function fetchPrices() {
      fetch('/api/prices')
        .then(r => r.json())
        .then(d => { if (d.ok) setLivePrices(d.prices ?? {}) })
        .catch(() => {})
    }
    fetchPrices()
    const interval = setInterval(fetchPrices, 30_000)
    return () => clearInterval(interval)
  }, [tab])

  async function cancelScheduled(id: string) {
    await fetch(`/api/schedule/${id}`, { method: 'DELETE' })
    setScheduled(prev => prev.filter(s => s.id !== id))
  }

  async function cancelCondition(id: string) {
    await fetch(`/api/conditions/${id}`, { method: 'DELETE' })
    setConditions(prev => prev.filter(c => c.id !== id))
  }

  if (!open) {
    // Desktop-only edge toggle (mobile uses the hamburger in the header instead)
    return (
      <button
        onClick={() => setOpen(true)}
        className="hidden md:block fixed right-0 top-1/2 -translate-y-1/2 bg-[#111118] border border-white/8 text-slate-500 text-xs px-2 py-6 rounded-l-lg hover:border-purple-500/30 hover:text-purple-300 transition-colors z-10"
        title="Open sidebar"
      >
        ‹
      </button>
    )
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'portfolio', label: 'Port' },
    { key: 'history',   label: 'Hist' },
    { key: 'scheduled', label: 'Sched' },
    { key: 'watching',  label: 'Watch' },
    { key: 'positions', label: 'Pos' },
  ]

  return (
    <>
      {/* Mobile backdrop — md:hidden, only visible when drawer is open */}
      <div
        onClick={onMobileClose}
        className={`md:hidden fixed inset-0 bg-black/60 z-30 transition-opacity ${
          mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      <div
        className={[
          // Mobile: fixed slide-over drawer
          'fixed inset-y-0 right-0 z-40 w-[85vw] max-w-sm transform transition-transform duration-300',
          mobileOpen ? 'translate-x-0' : 'translate-x-full',
          // Desktop: restore inline w-72 (original layout)
          'md:static md:translate-x-0 md:w-72 md:max-w-none md:transform-none md:transition-none md:z-auto md:shrink-0',
          // Shared
          'border-l border-white/5 bg-[#0d0d12] flex flex-col',
        ].join(' ')}
      >
      {/* Mobile-only page switcher (Chat / Echo). Desktop uses the header nav. */}
      {onPageChange && (
        <div className="md:hidden flex gap-2 p-3 border-b border-white/5 shrink-0">
          {(['chat', 'echo'] as const).map(page => (
            <button
              key={page}
              onClick={() => { onPageChange(page); onMobileClose?.() }}
              className={`flex-1 py-2.5 rounded-lg text-xs font-mono uppercase tracking-widest transition-colors flex items-center justify-center gap-1.5 ${
                currentPage === page
                  ? 'bg-purple-600/20 border border-purple-500/30 text-purple-300'
                  : 'border border-white/8 text-slate-400 hover:text-slate-200'
              }`}
            >
              {page === 'echo' && echoAlertCount > 0 && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              )}
              {page}
            </button>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-white/5 shrink-0">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-3 min-h-[44px] md:min-h-0 text-[11px] md:text-[9px] uppercase tracking-widest font-mono transition-colors ${
              tab === t.key
                ? 'text-purple-400 border-b border-purple-500'
                : 'text-slate-600 hover:text-slate-400'
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => setOpen(false)}
          className="px-2 text-slate-700 hover:text-slate-400 text-xs"
        >
          ›
        </button>
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">

        {/* Portfolio tab */}
        {tab === 'portfolio' && (
          <>
            {portfolio ? (
              <>
                <div className="rounded-xl border border-white/5 bg-[#111118] p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Total Value</span>
                    <button onClick={onRefresh} className="text-[10px] text-slate-600 hover:text-purple-400 transition-colors" title="Refresh">↻</button>
                  </div>
                  <p className="text-2xl font-bold text-white">
                    {displayTotal !== null ? `$${displayTotal.toFixed(2)}` : '—'}
                  </p>
                </div>

                <div className="space-y-2">
                  {portfolio.balances.slice(0, 6).map(b => (
                    <div key={b.symbol} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#111118] border border-white/5">
                      <div className="flex items-center gap-2">
                        <TokenIcon symbol={b.symbol} />
                        <span className="text-sm text-white font-medium">{b.symbol}</span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-white">{b.formatted}</p>
                        <p className="text-[10px] text-slate-500">
                          {b.usdValue > 0 ? `$${b.usdValue.toFixed(2)}` : '—'}
                        </p>
                      </div>
                    </div>
                  ))}
                  {portfolio.balances.length === 0 && <Empty label="No token balances detected." />}
                </div>

                {portfolio.navi && (
                  <div className="rounded-xl border border-white/5 bg-[#111118] p-4 space-y-2">
                    <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">NAVI Positions</p>
                    {portfolio.navi.healthFactor !== null && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-400">Health Factor</span>
                        <span className={`text-sm font-bold ${
                          portfolio.navi.healthFactor > 2 ? 'text-emerald-400'
                          : portfolio.navi.healthFactor > 1.5 ? 'text-yellow-400'
                          : 'text-red-400'
                        }`}>{portfolio.navi.healthFactor.toFixed(2)}</span>
                      </div>
                    )}
                    {Object.entries(portfolio.navi.supplyBalances).map(([sym, bal]) => (
                      <div key={sym} className="flex justify-between text-xs">
                        <span className="text-slate-500">↑ {sym} supplied</span>
                        <span className="text-emerald-400">{bal.toFixed(4)}</span>
                      </div>
                    ))}
                    {Object.entries(portfolio.navi.borrowBalances).map(([sym, bal]) => (
                      <div key={sym} className="flex justify-between text-xs">
                        <span className="text-slate-500">↓ {sym} borrowed</span>
                        <span className="text-red-400">{bal.toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <Empty label={wallet ? 'Loading portfolio…' : 'Connect wallet to view portfolio.'} />
            )}
          </>
        )}

        {/* History tab */}
        {tab === 'history' && (
          <>
            {history.length === 0 ? (
              <Empty label="No intents logged yet. Start by typing a command." />
            ) : history.map(h => (
              <div key={h.id} className="rounded-xl border border-white/5 bg-[#111118] p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className={`text-[9px] font-mono uppercase tracking-widest ${intentColor(h.type ?? '')}`}>
                    · {(h.type ?? 'unknown').replace(/_/g, ' ')}
                  </span>
                  <span className={`text-[9px] font-mono ${h.status === 'success' ? 'text-emerald-500' : h.status === 'failed' ? 'text-red-500' : 'text-yellow-500'}`}>
                    {h.status}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">{h.summary}</p>
                <p className="text-[9px] text-slate-600">
                  {new Date(h.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            ))}
          </>
        )}

        {/* Scheduled tab */}
        {tab === 'scheduled' && (
          <>
            {scheduled.length === 0 ? (
              <Empty label="No scheduled transactions. Try: DCA 10 USDC into SUI every day for 30 days." />
            ) : scheduled.map(item => (
              <div key={item.id} className="rounded-xl border border-white/5 bg-[#111118] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-purple-400 uppercase tracking-widest">
                    {item.type === 'dca' ? '· DCA' : '· PAYMENT'}
                  </span>
                  <button
                    onClick={() => cancelScheduled(item.id)}
                    className="text-sm md:text-[10px] min-h-[40px] md:min-h-0 px-2 -mx-2 text-slate-600 hover:text-red-400 transition-colors"
                  >
                    cancel
                  </button>
                </div>
                <p className="text-sm text-white">
                  {item.amount} {item.token}{item.targetToken ? ` → ${item.targetToken}` : ''}
                </p>
                <p className="text-xs text-slate-500 capitalize">{item.schedule.frequency}</p>
                <div className="flex justify-between text-[10px] text-slate-600">
                  <span>Next: {new Date(item.schedule.nextRun).toLocaleDateString()}</span>
                  {item.schedule.totalRuns > 0 && (
                    <span>{item.schedule.completedRuns}/{item.schedule.totalRuns} runs</span>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Watching tab */}
        {tab === 'watching' && (
          <>
            {conditions.length === 0 ? (
              <Empty label='No active conditions. Try: "Swap my SUI to USDC if SUI drops below $3"' />
            ) : conditions.map(c => (
              <div key={c.id} className="rounded-xl border border-white/5 bg-[#111118] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-yellow-400 uppercase tracking-widest">· WATCHING</span>
                  <button
                    onClick={() => cancelCondition(c.id)}
                    className="text-sm md:text-[10px] min-h-[40px] md:min-h-0 px-2 -mx-2 text-slate-600 hover:text-red-400 transition-colors"
                  >
                    cancel
                  </button>
                </div>
                <p className="text-xs text-white leading-relaxed">{c.description}</p>
                <p className="text-[10px] font-mono text-slate-500">
                  {c.trigger.asset} {c.trigger.type === 'price_below' ? '<' : '>'} ${c.trigger.threshold}
                </p>
              </div>
            ))}
          </>
        )}

        {/* Positions tab */}
        {tab === 'positions' && (
          <>
            {positions.length === 0 ? (
              <Empty label='No open positions. Try: "Buy LOFI and exit at 10% profit"' />
            ) : positions.map(p => {
              // Feature 2: Live PnL calculation
              const currentPrice  = livePrices[p.token.toUpperCase()] ?? null
              const entryUsd      = p.entryAmountUsd
              // Simple PnL estimation based on token price movement
              // If we have a current price and can compare to "now"
              const pnlPct   = currentPrice != null && entryUsd > 0
                ? null // token price alone isn't enough without entry price — show as n/a
                : null
              const hasPnl = pnlPct !== null

              return (
                <div key={p.id} className="rounded-xl border border-white/5 bg-[#111118] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-purple-400 uppercase tracking-widest">· {p.token}</span>
                    <span className="text-[10px] text-slate-600">{new Date(p.openedAt).toLocaleDateString()}</span>
                  </div>
                  <p className="text-sm text-white">${entryUsd.toFixed(2)} entry</p>

                  {/* Live price badge */}
                  {currentPrice != null && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">Current:</span>
                      <span className="text-xs text-white font-mono">${currentPrice.toFixed(4)}</span>
                      <span className="text-[9px] text-emerald-400 animate-pulse">● live</span>
                    </div>
                  )}

                  {hasPnl && (
                    <p className={`text-xs font-semibold ${(pnlPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      PnL: {(pnlPct ?? 0) >= 0 ? '+' : ''}{((pnlPct ?? 0) * 100).toFixed(2)}%
                    </p>
                  )}

                  {p.profitTarget && (
                    <p className="text-xs text-emerald-400/80">Target: +{(p.profitTarget * 100).toFixed(0)}%</p>
                  )}
                  {p.stopLoss && (
                    <p className="text-xs text-red-400/80">Stop: −{(p.stopLoss * 100).toFixed(0)}%</p>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
      </div>
    </>
  )
}
