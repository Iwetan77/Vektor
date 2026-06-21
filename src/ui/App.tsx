import { useState, useRef, useEffect, useCallback } from 'react'
import { useCurrentAccount, useDisconnectWallet, useSuiClientQuery, useSignAndExecuteTransaction } from '@mysten/dapp-kit'
import { useAuthFetch } from './lib/authFetch.js'
import { recordHistory, updateHistoryStatus } from './lib/history.js'
import { isNeedResign } from './useZkLogin.js'
import { Transaction } from '@mysten/sui/transactions'
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { toBase64 } from '@mysten/sui/utils'
import { PTBPreview }       from './PTBPreview.js'
import { SwapQuoteCard }    from './cards/SwapQuoteCard.js'
import { TransactionReceiptCard } from './cards/TransactionReceiptCard.js'
import { BundleReceiptCard }      from './cards/BundleReceiptCard.js'
import { GuardianReport }   from './GuardianReport.js'
import { ConfirmationGate } from './ConfirmationGate.js'
import { Sidebar }          from './Sidebar.js'
import { ContactsPage }     from './ContactsPage.js'
import { MicButton }        from './MicButton.js'
import EchoPage             from './EchoPage.js'
import { WelcomePage }      from './WelcomePage.js'
import { LandingPage }      from './LandingPage.js'
import { useZkLogin }       from './useZkLogin.js'
import type { EchoWsMessage } from '../echo/types.js'

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type AppState = 'idle' | 'loading' | 'review' | 'rewriting' | 'rewritten' | 'confirmed'

interface GuardData {
  parsedIntent: any
  quote:        any
  report:       any
  _rawReport:   any
  quoteParams?: { from: string; to: string; amountIn: string; slippage: number; sender: string }
  diff?:        any     // before/after rewrite comparison
  rewriteNote?: string  // set when rewrite produced no improvement
}

interface ChatMessage {
  id:           string
  role:         'user' | 'vektor'
  text?:        string
  actionLabel?: string
  loading?:     boolean
  originalText?: string
  guardData?:   GuardData
  phase?:       'review' | 'rewriting' | 'rewritten' | 'confirmed'
  // Rich payload for non-swap intents
  intentType?:     string
  payload?:        any
  executionDigest?: string
  executionError?:  string
  executedAt?:      number   // epoch ms when execution succeeded — for receipt timestamp
  language?:        string   // ISO 639-1 code of detected language
  recordId?:        string   // History record id — used to report final exec status
}

/* ─── Vektor SVG components ──────────────────────────────────────────────── */

function VektorLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 772 260" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-label="Vektor">
      <path d="M260 129.471L248.649 150.796L199.934 124.865L196.939 218.719L172.791 217.949L176.405 104.7L194.155 94.4225L260 129.471Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M155.3 176.405L165.577 194.155L130.529 260L109.204 248.649L135.133 199.934L41.2811 196.939L42.0509 172.791L155.3 176.405Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M83.5947 155.3L87.2089 42.0509L63.061 41.2811L60.0646 135.133L11.3514 109.204L0 130.529L65.845 165.577L83.5947 155.3Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M150.796 11.3514L124.865 60.0646L218.719 63.061L217.949 87.2089L104.7 83.5947L94.4225 65.845L129.471 0L150.796 11.3514Z" fill="currentColor"/>
      <path d="M722.369 185.721V117.939H714.247V101.694H731.052V117.379H736.934C739.268 112.244 742.863 108.229 747.718 105.335C752.666 102.441 758.455 100.994 765.083 100.994H771.946V114.438H764.243C755.84 114.438 749.352 116.912 744.777 121.86C740.202 126.809 737.914 133.484 737.914 141.887V185.721H722.369Z" fill="currentColor"/>
      <path d="M662.671 187.402C653.988 187.402 646.379 185.628 639.843 182.08C633.401 178.439 628.406 173.351 624.858 166.815C621.31 160.28 619.536 152.577 619.536 143.708C619.536 134.838 621.31 127.136 624.858 120.6C628.406 114.065 633.401 109.023 639.843 105.475C646.379 101.834 653.988 100.013 662.671 100.013C671.634 100.013 679.289 101.787 685.638 105.335C692.08 108.883 697.029 113.925 700.483 120.46C704.031 126.995 705.805 134.745 705.805 143.708C705.805 152.577 704.031 160.326 700.483 166.955C697.029 173.491 692.08 178.532 685.638 182.08C679.196 185.628 671.54 187.402 662.671 187.402ZM662.671 173.677C671.353 173.677 678.076 171.063 682.837 165.835C687.692 160.513 690.12 153.137 690.12 143.708C690.12 134.184 687.692 126.809 682.837 121.58C678.076 116.352 671.353 113.738 662.671 113.738C654.081 113.738 647.359 116.399 642.504 121.72C637.649 126.949 635.222 134.278 635.222 143.708C635.222 153.137 637.649 160.513 642.504 165.835C647.359 171.063 654.081 173.677 662.671 173.677Z" fill="currentColor"/>
      <path d="M587.864 185.721C583.383 185.721 579.882 184.601 577.361 182.36C574.933 180.026 573.72 176.572 573.72 171.997V113.738H558.034V101.694H573.86V76.4856H589.265V101.694H611.252V113.738H589.405V173.397H613.493V185.721H587.864Z" fill="currentColor"/>
      <path d="M422.428 187.402C413.652 187.402 406.043 185.628 399.601 182.08C393.159 178.439 388.164 173.304 384.616 166.675C381.162 160.046 379.434 152.297 379.434 143.428C379.434 134.558 381.162 126.902 384.616 120.46C388.164 113.925 393.112 108.883 399.461 105.335C405.81 101.787 413.232 100.013 421.728 100.013C429.851 100.013 436.853 101.647 442.735 104.915C448.71 108.183 453.332 112.804 456.6 118.779C459.867 124.755 461.501 131.85 461.501 140.066V146.368H394.559C395.026 155.145 397.687 162.007 402.542 166.955C407.49 171.81 414.072 174.238 422.288 174.238C427.984 174.238 432.792 173.071 436.713 170.736C440.634 168.309 443.342 164.761 444.836 160.093H460.801C458.747 168.776 454.312 175.498 447.497 180.26C440.774 185.021 432.418 187.402 422.428 187.402ZM395.12 134.885H446.376C445.629 127.976 443.062 122.607 438.674 118.779C434.379 114.952 428.684 113.038 421.588 113.038C414.586 113.038 408.751 114.952 404.082 118.779C399.414 122.607 396.427 127.976 395.12 134.885Z" fill="currentColor"/>
      <path d="M475.445 185.721V68.0828H491.13V139.506H491.69L532.163 101.694H551.349L512.837 136.425L554.57 185.721H535.524L502.193 146.088L491.13 155.051V185.721H475.445Z" fill="currentColor"/>
      <path d="M370.058 67.8128L366.232 185.976L354.698 192.698L285 156.128L292.321 142.177L350.891 172.906L354.311 67.3025L370.058 67.8128Z" fill="currentColor"/>
    </svg>
  )
}

function VektorSymbol({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 449 449" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M449 223.586L429.397 260.413L345.271 215.633L340.099 377.711L298.397 376.381L304.638 180.81L335.291 163.06L449 223.586Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M268.19 304.638L285.94 335.291L225.414 449L188.587 429.397L233.364 345.271L71.2894 340.099L72.6186 298.397L268.19 304.638Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M144.362 268.19L150.603 72.6186L108.901 71.2894L103.727 233.364L19.603 188.587L0 225.414L113.709 285.94L144.362 268.19Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M260.413 19.603L215.633 103.727L377.711 108.901L376.381 150.603L180.81 144.362L163.06 113.709L223.586 0L260.413 19.603Z" fill="currentColor"/>
    </svg>
  )
}

/* ─── zkLogin avatar + dropdown ────────────────────────────────────────── */

function ZkAvatarMenu({
  zkLogin,
  addrCopied,
  setAddrCopied,
  portfolio,
}: {
  zkLogin: ReturnType<typeof useZkLogin>
  addrCopied: boolean
  setAddrCopied: (v: boolean) => void
  portfolio: any
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const user = zkLogin.user!
  const initial = (user.name ?? user.email ?? 'V').trim().charAt(0).toUpperCase()
  const addrShort = `${user.address.slice(0, 6)}…${user.address.slice(-4)}`

  const hasBalance = portfolio != null && (portfolio.balances?.length > 0 || portfolio.totalUsd > 0)
  const totalUsd = hasBalance ? `$${Number(portfolio.totalUsd).toFixed(2)}` : null

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(v => !v)}
        title={user.email ?? 'Account'}
        className="flex items-center justify-center w-9 h-9 rounded-full bg-purple-600 hover:bg-purple-500 ring-1 ring-purple-400/30 transition-colors"
      >
        <span className="text-sm font-semibold text-white">{initial}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-white/10 bg-[#0e0e14] shadow-2xl shadow-black/60 z-50">
          {/* Header — picture + name/email */}
          <div className="flex items-center gap-3 p-3 border-b border-white/5">
            <div className="w-10 h-10 rounded-full bg-purple-600 ring-1 ring-purple-400/30 flex items-center justify-center shrink-0">
              <span className="text-base font-semibold text-white">{initial}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white truncate">{user.name ?? user.email ?? 'Signed in'}</div>
              {user.email && user.name && (
                <div className="text-xs text-slate-500 truncate">{user.email}</div>
              )}
              <div className="text-[10px] font-mono text-slate-600 mt-0.5">via Google · zkLogin</div>
            </div>
          </div>

          {/* Total balance — combined USD value of every asset */}
          <div className="px-3 py-2.5 border-b border-white/5">
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1">Total balance</div>
            {totalUsd ? (
              <div className="text-lg font-semibold text-white">{totalUsd}</div>
            ) : (
              <div className="w-20 h-5 rounded bg-white/10 animate-pulse" />
            )}
          </div>

          {/* Address */}
          <div className="px-3 py-2.5 border-b border-white/5">
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1">Address</div>
            <div className="text-xs font-mono text-slate-300">{addrShort}</div>
          </div>

          {/* Actions */}
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(user.address)
                setAddrCopied(true)
                setTimeout(() => setAddrCopied(false), 1400)
              } catch {}
            }}
            className="w-full text-left px-3 py-2.5 text-sm text-slate-300 hover:bg-white/5 transition-colors border-b border-white/5 flex items-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            {addrCopied ? <span className="text-emerald-400">Copied</span> : 'Copy address'}
          </button>

          <button
            onClick={() => { setOpen(false); void zkLogin.signOut() }}
            className="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/* ─── Quick actions by category ─────────────────────────────────────────── */

const QUICK_ACTIONS = [
  'Swap 1 SUI to USDC',
  'Lend 100 USDC on NAVI',
  'DCA 10 USDC into SUI every day for 7 days',
  'Analyze my wallet',
]

const PLACEHOLDER = 'Drop an intent.'

/* ─── Label builder ──────────────────────────────────────────────────────── */

function buildSwapLabel(quote: any, report: any): string {
  const from      = (quote.fromSymbol ?? 'SUI').toUpperCase()
  const to        = (quote.toSymbol   ?? 'USDC').toUpperCase()
  const protocols = (quote.route ?? []).map((s: any) => s.protocol.toUpperCase())
  const score     = report?.score ?? '?'
  const chain     = protocols.length ? [from, ...protocols, to].join(' → ') : `${from} → ${to}`
  return `· SWAP · ${chain} · SCORE ${score}/100`
}

function buildRewriteLabel(quote: any, report: any): string {
  const protocols = (quote.route ?? []).map((s: any) => s.protocol.toUpperCase())
  const score     = report?.score ?? '?'
  const chain     = protocols.length ? protocols.join(' → ') : 'OPTIMIZED'
  return `· REWRITE · ${chain} · SCORE ${score}/100`
}

/* ─── Multi-step prompt chaining ─────────────────────────────────────────── *
 * Splits "swap all my WAL for SUI then send it to ebube" into ordered raw-text
 * steps on "then" / "and then" / "after that". A single-step prompt (the
 * overwhelming common case) returns its own text unchanged in a 1-length array
 * so callers can branch on `.length > 1` without a separate code path. */
function splitChainSteps(text: string): string[] {
  const parts = text.split(/\s*,?\s*(?:and\s+)?then\b\s*|\s*,?\s*after\s+that\b\s*/i)
    .map(s => s.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts : [text]
}

const CHAIN_CONTINUE_RE = /\b(go on|continue|proceed|go ahead|do it|yes|yeah|yep|yup|sure|ok|okay)\b/i
const CHAIN_STOP_RE     = /\b(stop|cancel|abort|no|nah|don'?t)\b/i

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function Spinner({ size = 4 }: { size?: number }) {
  return (
    <svg className={`w-${size} h-${size} animate-spin shrink-0`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

/* ─── Rich intent cards ──────────────────────────────────────────────────── */

function PriceCard({ token, price, message }: { token: string; price: number | null; message: string }) {
  return (
    <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 px-6 py-5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-slate-400 text-xs uppercase tracking-widest font-medium">{token} · Market Price</span>
      </div>
      {price != null ? (
        <p className="text-3xl font-bold text-white font-mono">
          ${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
        </p>
      ) : (
        <p className="text-slate-400 text-sm">{message}</p>
      )}
    </div>
  )
}

function PortfolioCard({ portfolio }: { portfolio: any }) {
  if (!portfolio) return null
  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] p-5 space-y-4">
      <div className="flex justify-between items-start">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Total Portfolio Value</p>
          <p className="text-3xl font-bold text-white mt-1">${portfolio.totalUsd?.toFixed(2) ?? '0.00'}</p>
        </div>
        {portfolio.navi?.healthFactor != null && (
          <div className={`px-3 py-1 rounded-full text-xs font-mono ${
            portfolio.navi.healthFactor > 2 ? 'bg-emerald-400/10 text-emerald-400'
            : portfolio.navi.healthFactor > 1.5 ? 'bg-yellow-400/10 text-yellow-400'
            : 'bg-red-400/10 text-red-400'
          }`}>
            HF {portfolio.navi.healthFactor.toFixed(2)}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {(portfolio.balances ?? []).slice(0, 6).map((b: any) => (
          <div key={b.symbol} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
            <span className="text-xs text-slate-400 font-medium">{b.symbol}</span>
            <div className="text-right">
              <p className="text-xs text-white">{b.formatted}</p>
              <p className="text-[10px] text-slate-600">${b.usdValue?.toFixed(2)}</p>
            </div>
          </div>
        ))}
      </div>
      {portfolio.navi && (Object.keys(portfolio.navi.supplyBalances ?? {}).length > 0) && (
        <div className="border-t border-white/5 pt-3 space-y-1">
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-600 mb-2">NAVI</p>
          {Object.entries(portfolio.navi.supplyBalances ?? {}).map(([s, v]) => (
            <div key={s} className="flex justify-between text-xs">
              <span className="text-slate-500">↑ Supplied {s}</span>
              <span className="text-emerald-400">{(v as number).toFixed(4)}</span>
            </div>
          ))}
          {Object.entries(portfolio.navi.borrowBalances ?? {}).map(([s, v]) => (
            <div key={s} className="flex justify-between text-xs">
              <span className="text-slate-500">↓ Borrowed {s}</span>
              <span className="text-red-400">{(v as number).toFixed(4)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function NaviCard({ payload, intentType, onSign, onCancel }: { payload: any; intentType: string; onSign?: () => void; onCancel?: () => void }) {
  const isLend   = intentType === 'lend'
  const isBorrow = intentType === 'borrow'
  const isRepay  = intentType === 'repay'
  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] p-5 space-y-3">
      <div className="flex items-center gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${
          isLend ? 'bg-emerald-500/10 text-emerald-400' : isBorrow ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'
        }`}>
          {isLend ? '↑' : isBorrow ? '↓' : '↩'}
        </div>
        <div>
          <p className="text-sm font-semibold text-white capitalize">{intentType} on NAVI</p>
          {payload?.healthFactor != null && (
            <p className={`text-xs ${payload.healthFactor > 2 ? 'text-emerald-400' : payload.healthFactor > 1.5 ? 'text-yellow-400' : 'text-red-400'}`}>
              Health Factor: {payload.healthFactor.toFixed(2)}
            </p>
          )}
        </div>
      </div>
      {isBorrow && !payload?.safeToBorrow && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
          ⚠️ Health factor too low to safely borrow. Repay existing debt first.
        </div>
      )}
      {payload?.poolRates && (
        <div className="text-xs text-slate-500 space-y-1">
          {payload.poolRates.base_supply_rate && (
            <p>Supply APY: <span className="text-emerald-400">{(Number(payload.poolRates.base_supply_rate) * 100).toFixed(2)}%</span></p>
          )}
          {payload.poolRates.base_borrow_rate && (
            <p>Borrow APY: <span className="text-amber-400">{(Number(payload.poolRates.base_borrow_rate) * 100).toFixed(2)}%</span></p>
          )}
        </div>
      )}
      <p className="text-xs text-slate-500">
        {payload?.ptbB64
          ? 'Transaction ready — sign and execute below.'
          : 'Transaction will be built on-chain before signing.'}
      </p>
      {onSign && (
        <div className="flex gap-2">
          <button
            onClick={onSign}
            className="flex-1 py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 hover:border-purple-500/60 text-purple-300 text-xs font-semibold transition-colors"
          >
            Sign &amp; Execute on NAVI →
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-white/[0.02] hover:bg-red-500/10 border border-white/10 hover:border-red-500/40 text-slate-400 hover:text-red-300 text-xs font-semibold transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ScheduledCard({ payload }: { payload: any }) {
  const s = payload?.scheduled
  if (!s) return null
  const freqMap: Record<string, string> = { daily: 'Every day', weekly: `Every ${s.schedule?.dayOfWeek ?? 'week'}`, monthly: 'Every month', once: 'One time' }
  return (
    <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-purple-400">⏱</span>
        <span className="text-sm font-semibold text-white capitalize">{s.type === 'dca' ? 'DCA' : 'Scheduled Payment'} Created</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div><p className="text-slate-500">Amount</p><p className="text-white">{s.amount} {s.token}{s.targetToken ? ` → ${s.targetToken}` : ''}</p></div>
        <div><p className="text-slate-500">Frequency</p><p className="text-white capitalize">{freqMap[s.schedule?.frequency] ?? s.schedule?.frequency}</p></div>
        <div><p className="text-slate-500">First run</p><p className="text-white">{new Date(s.schedule?.nextRun).toLocaleDateString()}</p></div>
        {s.schedule?.totalRuns > 0 && <div><p className="text-slate-500">Total runs</p><p className="text-white">{s.schedule.totalRuns}</p></div>}
      </div>
      <p className="text-[10px] text-slate-600 font-mono">ID: {s.id}</p>
    </div>
  )
}

function ConditionCard({ payload }: { payload: any }) {
  const c = payload?.condition
  if (!c) return null
  return (
    <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-yellow-400 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11L10 22L19.5 10.5H13L13 2Z"/></svg>
        <span className="text-sm font-semibold text-white">Condition Armed</span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{c.description}</p>
      <div className="flex items-center gap-4 text-xs">
        <div>
          <p className="text-slate-500">Trigger</p>
          <p className="text-white font-mono">{c.trigger.asset} {c.trigger.type === 'price_below' ? '<' : '>'} ${c.trigger.threshold}</p>
        </div>
        {payload.currentPrice != null && (
          <div>
            <p className="text-slate-500">Current</p>
            <p className="text-white font-mono">${payload.currentPrice.toFixed(4)}</p>
          </div>
        )}
      </div>
      <p className="text-[10px] text-slate-600">Polling every 30s via Pyth oracle.</p>
    </div>
  )
}

function ExplainCard({ payload }: { payload: any }) {
  const r = payload?.explanation
  if (!r) return null
  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] p-5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Transaction</span>
        <a
          href={`https://suiscan.xyz/mainnet/tx/${r.digest}`}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-purple-400 hover:text-purple-300 font-mono"
        >
          {r.digest.slice(0, 10)}… ↗
        </a>
      </div>
      <p className="text-sm text-slate-200 leading-relaxed">{r.explanation}</p>
      <div className="flex gap-4 text-xs">
        <div><p className="text-slate-500">Status</p><p className={r.status === 'success' ? 'text-emerald-400' : 'text-red-400'}>{r.status}</p></div>
        <div><p className="text-slate-500">Gas</p><p className="text-white">{r.gasUsed?.toFixed(6)} SUI</p></div>
      </div>
    </div>
  )
}

function PaymentCard({ payload, paymentId }: { payload: any; paymentId?: string }) {
  const [copied,  setCopied]  = useState(false)
  const [status,  setStatus]  = useState<string>(payload?.payment?.status ?? 'pending')
  const [paidAt,  setPaidAt]  = useState<string | null>(payload?.payment?.paidAt ?? null)
  const link = payload?.paymentLink ?? (paymentId ? `${window.location.origin}?pay=${paymentId}` : '')

  // Feature 10: poll for payment status
  useEffect(() => {
    const id = paymentId ?? payload?.payment?.id
    if (!id || status === 'paid') return
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`/api/payment/${id}`)
        const d = await r.json()
        if (d.ok && d.payment.status === 'paid') {
          setStatus('paid')
          setPaidAt(d.payment.paidAt ?? null)
          clearInterval(interval)
        }
      } catch { /* ignore */ }
    }, 4000)
    return () => clearInterval(interval)
  }, [paymentId, payload?.payment?.id, status])

  function copy() {
    navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] p-5 space-y-4">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Payment Request</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div><p className="text-slate-500">Amount</p><p className="text-white">{payload?.payment?.amount} {payload?.payment?.token}</p></div>
        <div>
          <p className="text-slate-500">Status</p>
          <p className={`capitalize font-semibold ${status === 'paid' ? 'text-emerald-400' : 'text-yellow-400'}`}>
            {status === 'paid' ? '✓ Paid' : '⏳ Pending'}
          </p>
        </div>
      </div>
      {paidAt && (
        <p className="text-[10px] text-slate-600">Paid {new Date(paidAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
      )}
      {link && (
        <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3 flex items-center gap-2">
          <p className="flex-1 text-xs text-slate-400 font-mono truncate">{link}</p>
          <button onClick={copy} className="text-[10px] text-purple-400 hover:text-purple-300 shrink-0">
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}

function InviteLinkCard({ payload }: { payload: any }) {
  const [copied, setCopied] = useState(false)
  const link = payload?.inviteLink ?? ''

  function copy() {
    if (!link) return
    navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] p-5 space-y-3">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Invite Link</p>
      <p className="text-sm text-slate-300 leading-relaxed">
        Send this link to {payload?.recipient || 'a friend'} to claim {payload?.token === 'USDC' ? `$${payload?.amount} USDC` : `${payload?.amount} ${payload?.token}`}.
      </p>
      {link && (
        <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3 flex items-center gap-2">
          <p className="flex-1 text-xs text-slate-400 font-mono truncate">{link}</p>
          <button
            onClick={copy}
            title="Copy link"
            className="shrink-0 flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300 transition-colors"
          >
            {copied ? (
              '✓ Copied'
            ) : (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
                Copy
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

function GeneralCard({ message }: { message: string }) {
  return (
    <div className="px-4 py-3 rounded-xl border border-white/5 bg-[#111118] text-sm text-slate-300 leading-relaxed whitespace-pre-line">
      {message}
    </div>
  )
}

function BatchPaymentCard({ payload, onSign, onCancel }: { payload: any; onSign?: () => void; onCancel?: () => void }) {
  const bd = payload?.batchData
  if (!bd) return null
  const isSplit = payload?.intent_type === 'split_payment'
  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono uppercase tracking-widest ${isSplit ? 'text-blue-400' : 'text-purple-400'}`}>
            {isSplit ? '· SPLIT PAYMENT' : '· BATCH PAYMENT'}
          </span>
        </div>
        <span className="text-xs font-semibold text-white">
          {bd.totalAmount} {bd.token}
        </span>
      </div>
      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {(bd.members ?? []).map((m: any, i: number) => (
          <div key={i} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg bg-white/[0.03]">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-purple-600/20 text-purple-400 text-[9px] font-bold flex items-center justify-center shrink-0">
                {m.name?.[0]?.toUpperCase() ?? '?'}
              </span>
              <span className="text-slate-300">{m.name}</span>
            </div>
            <div className="text-right">
              <span className="text-white font-mono">{m.amount ?? bd.amountPerPerson} {bd.token}</span>
              <p className="text-[9px] text-slate-600 font-mono">{m.address?.slice(0, 8)}…</p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-600 pt-1 border-t border-white/5">
        <span>{bd.members?.length ?? 0} recipients · 1 atomic transaction</span>
        <span className="text-white/40">{bd.token}</span>
      </div>
      {onSign && (
        <div className="flex gap-2">
          <button
            onClick={onSign}
            className="flex-1 py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 hover:border-purple-500/60 text-purple-300 text-xs font-semibold transition-colors"
          >
            Sign &amp; Execute Batch →
          </button>
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-white/[0.02] hover:bg-red-500/10 border border-white/10 hover:border-red-500/40 text-slate-400 hover:text-red-300 text-xs font-semibold transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TransactionHistoryCard({ txs }: { txs: any[] }) {
  return (
    <div className="rounded-xl border border-white/5 bg-[#111118] p-5 space-y-3">
      <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Recent Transactions</p>
      {(!txs || txs.length === 0) ? (
        <p className="text-xs text-slate-600 py-2">No recent transactions found for this wallet.</p>
      ) : (
        <div className="space-y-0">
          {txs.slice(0, 10).map((tx: any, i: number) => {
            const digest    = typeof tx.digest === 'string' ? tx.digest : null
            const status    = tx.status ?? 'unknown'
            const isSuccess = status === 'success'
            let dateStr = ''
            try { if (tx.timestamp) dateStr = new Date(tx.timestamp).toLocaleDateString() } catch {}
            return (
              <div key={digest ?? i} className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0">
                <div className="flex items-center gap-2.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSuccess ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <span className="text-xs text-slate-400 font-mono">
                    {digest ? `${digest.slice(0, 8)}…${digest.slice(-4)}` : 'unknown'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] font-mono ${isSuccess ? 'text-emerald-400' : 'text-red-400'}`}>
                    {status}
                  </span>
                  {dateStr && <span className="text-[10px] text-slate-600">{dateStr}</span>}
                  {digest && (
                    <a
                      href={`https://suiscan.xyz/mainnet/tx/${digest}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-purple-400 hover:text-purple-300 transition-colors"
                    >
                      ↗
                    </a>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ─── Execution result i18n ──────────────────────────────────────────────── */

interface ExecStrings {
  executed:    string   // "Swap executed on Sui mainnet"
  digest:      string   // "Digest:"
  failed:      string   // "Transaction failed"
  awaiting:    string   // "Awaiting wallet…"
  approveHint: string   // "Approve the transaction in your wallet extension"
}

const EXEC_I18N: Record<string, ExecStrings> = {
  en: { executed: 'Swap executed on Sui mainnet', digest: 'Digest:', failed: 'Transaction failed', awaiting: 'Awaiting wallet…', approveHint: 'Approve the transaction in your wallet extension' },
  fr: { executed: 'Swap exécuté sur Sui mainnet', digest: 'Résumé :', failed: 'Transaction échouée', awaiting: 'En attente du portefeuille…', approveHint: 'Approuvez la transaction dans votre extension de portefeuille' },
  es: { executed: 'Swap ejecutado en Sui mainnet', digest: 'Resumen:', failed: 'Transacción fallida', awaiting: 'Esperando billetera…', approveHint: 'Aprueba la transacción en tu extensión de billetera' },
  pt: { executed: 'Swap executado na Sui mainnet', digest: 'Resumo:', failed: 'Transação falhou', awaiting: 'Aguardando carteira…', approveHint: 'Aprove a transação na extensão da sua carteira' },
  yo: { executed: 'A ṣe swap lori Sui mainnet', digest: 'Àkọsílẹ̀:', failed: 'Ìdúnàádúrà kùnà', awaiting: 'Ń dúró de àpamọ́wọlé…', approveHint: 'Fọwọ́ sí ìdúnàádúrà nínú àfikún àpamọ́wọlé rẹ' },
  ha: { executed: 'An aiwatar da swap a kan Sui mainnet', digest: 'Taƙaitawa:', failed: "Ma'amala ta gaza", awaiting: 'Ana jiran walat…', approveHint: 'Amince da ma\'amala a cikin ƙarin walat ɗin ku' },
  ig: { executed: 'Emere swap na Sui mainnet', digest: 'Nchoputa:', failed: 'Azụmahịa dara ada', awaiting: 'Na-atọ ndị ọrụ akpa ego…', approveHint: 'Kwenye azụmahịa na mgbakwunye akpa ego gị' },
  ar: { executed: 'تم تنفيذ الصفقة على Sui mainnet', digest: 'الملخص:', failed: 'فشلت المعاملة', awaiting: 'بانتظار المحفظة…', approveHint: 'وافق على المعاملة في امتداد محفظتك' },
  zh: { executed: '交易已在 Sui 主网执行', digest: '摘要：', failed: '交易失败', awaiting: '等待钱包确认…', approveHint: '请在您的钱包插件中批准此交易' },
  ja: { executed: 'Sui メインネットでスワップが実行されました', digest: 'ダイジェスト：', failed: 'トランザクション失敗', awaiting: 'ウォレット承認待ち…', approveHint: 'ウォレット拡張機能でトランザクションを承認してください' },
  de: { executed: 'Swap auf Sui Mainnet ausgeführt', digest: 'Zusammenfassung:', failed: 'Transaktion fehlgeschlagen', awaiting: 'Warte auf Wallet…', approveHint: 'Bestätigen Sie die Transaktion in Ihrer Wallet-Erweiterung' },
  ko: { executed: 'Sui 메인넷에서 스왑이 실행되었습니다', digest: '다이제스트:', failed: '트랜잭션 실패', awaiting: '지갑 승인 대기 중…', approveHint: '지갑 확장 프로그램에서 트랜잭션을 승인하세요' },
  ru: { executed: 'Своп выполнен в сети Sui mainnet', digest: 'Хеш:', failed: 'Транзакция не удалась', awaiting: 'Ожидание кошелька…', approveHint: 'Подтвердите транзакцию в расширении кошелька' },
  tr: { executed: "Sui mainnet'te takas gerçekleştirildi", digest: 'Özet:', failed: 'İşlem başarısız', awaiting: 'Cüzdan bekleniyor…', approveHint: 'Cüzdan uzantınızda işlemi onaylayın' },
  sw: { executed: 'Ubadilishaji umefanyika kwenye Sui mainnet', digest: 'Muhtasari:', failed: 'Muamala umeshindwa', awaiting: 'Kusubiri pochi…', approveHint: 'Thibitisha muamala katika kiendelezi cha pochi yako' },
}

function execT(lang: string | undefined): ExecStrings {
  return EXEC_I18N[lang ?? 'en'] ?? EXEC_I18N['en']
}

/* ─── Message bubble ──────────────────────────────────────────────────────── */

interface BubbleProps {
  msg:          ChatMessage
  onFix:        () => void
  onConfirm:    () => void
  onReset:      () => void
  onSign:       () => void
  onBatchSign:  () => void
  onSendSign:   () => void
  onOnboardFundSign: () => void
}

function MessageBubble({ msg, onFix, onConfirm, onReset, onSign, onBatchSign, onSendSign, onOnboardFundSign }: BubbleProps) {
  if (msg.role === 'user') {
    return (
      <div className="msg-in flex justify-end">
        <div className="max-w-[72%] px-4 py-3 rounded-2xl rounded-tr-sm bg-purple-600/15 border border-purple-500/20 text-sm text-white leading-relaxed">
          {msg.text}
        </div>
      </div>
    )
  }

  return (
    <div className="msg-in flex flex-col gap-2 max-w-full">
      <div className="flex items-center gap-2 pl-0.5 flex-wrap">
        <div className="flex items-center gap-1.5 text-purple-400">
          <VektorSymbol className="w-3.5 h-3.5" />
          <span className="text-[11px] font-bold font-mono tracking-widest">VEKTOR</span>
        </div>
        {msg.actionLabel && (
          <span className="text-[10px] text-purple-400 uppercase tracking-widest font-mono opacity-80">
            {msg.actionLabel}
          </span>
        )}
        {msg.language && msg.language !== 'en' && (
          <span className="text-[9px] font-mono text-slate-600 border border-white/8 px-1.5 py-0.5 rounded uppercase tracking-widest">
            {msg.language}
          </span>
        )}
      </div>

      {msg.loading && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/5 bg-[#111118] text-sm text-slate-400">
          <Spinner />
          <span className="font-mono text-xs uppercase tracking-widest text-slate-500">
            {msg.actionLabel ?? 'Processing…'}
          </span>
        </div>
      )}

      {!msg.loading && (() => {
        const it = msg.intentType

        // Swap / Guardian flow
        if (msg.guardData && msg.phase !== 'confirmed') return (
          <div className="space-y-4">
            {msg.guardData.quote?.amountOutFormatted !== undefined
              ? <SwapQuoteCard quote={msg.guardData.quote} parsedIntent={msg.guardData.parsedIntent} />
              : <PTBPreview parsedIntent={msg.guardData.parsedIntent} quote={msg.guardData.quote} originalText={msg.originalText ?? ''} />}
            <GuardianReport report={msg.guardData.report} rewriting={msg.phase === 'rewriting'} wasRewritten={msg.phase === 'rewritten'} diff={msg.guardData.diff} onFix={onFix} />
            {msg.guardData.rewriteNote && (
              <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-300/80">
                ⚠ {msg.guardData.rewriteNote}
              </div>
            )}
            <ConfirmationGate report={msg.guardData.report} quote={msg.guardData.quote} parsedIntent={msg.guardData.parsedIntent} state={msg.phase as AppState} onConfirm={onConfirm} onReset={onReset} language={msg.language} />
          </div>
        )

        if (msg.guardData && msg.phase === 'confirmed') {
          const ex = execT(msg.language)

          // Execution succeeded — rich receipt card
          if (msg.executionDigest) {
            const q = msg.guardData.quote
            return (
              <TransactionReceiptCard
                digest={msg.executionDigest}
                title={ex.executed}
                fromLabel={q?.amountInFormatted  ? `${q.amountInFormatted} ${q.fromSymbol ?? ''}`.trim()  : undefined}
                toLabel={q?.amountOutFormatted ? `${q.amountOutFormatted} ${q.toSymbol ?? ''}`.trim() : undefined}
                executedAt={msg.executedAt}
              />
            )
          }
          // Wallet rejected / execution error
          if (msg.executionError) return (
            <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-6 py-5 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-red-400">✕</span>
                <span className="text-white font-semibold text-sm">{ex.failed}</span>
              </div>
              <p className="text-xs text-red-300/70">{msg.executionError}</p>
            </div>
          )
          // Still executing / awaiting wallet
          return (
            <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 px-6 py-5 space-y-2">
              <div className="flex items-center gap-2">
                <Spinner />
                <span className="text-white font-semibold text-sm">{ex.awaiting}</span>
              </div>
              <p className="text-xs text-slate-600 font-mono">{ex.approveHint}</p>
            </div>
          )
        }

        if (it === 'check_balance') {
          // Single-token query: show the focused balance text, then the full card below
          if (msg.text) return (
            <div className="space-y-4">
              <GeneralCard message={msg.text} />
              <PortfolioCard portfolio={msg.payload?.portfolio} />
            </div>
          )
          return <PortfolioCard portfolio={msg.payload?.portfolio} />
        }
        if (it === 'analyze_wallet') return (
          <div className="space-y-4">
            {msg.text && <GeneralCard message={msg.text} />}
            <PortfolioCard portfolio={msg.payload?.portfolio} />
          </div>
        )
        if (it === 'transaction_history') return (
          <div className="space-y-3">
            {msg.text && <GeneralCard message={msg.text} />}
            <TransactionHistoryCard txs={msg.payload?.txs ?? []} />
          </div>
        )
        if (it === 'lend' || it === 'borrow' || it === 'repay') {
          if (msg.executionDigest) {
            const pi = msg.payload?.parsedIntent
            const amt = pi?.input_amount
            const tok = (pi?.input_asset ?? '').toUpperCase()
            return (
              <TransactionReceiptCard
                digest={msg.executionDigest}
                title={`${it.charAt(0).toUpperCase()}${it.slice(1)} executed on NAVI`}
                fromLabel={amt ? `${amt} ${tok}`.trim() : undefined}
                toLabel={amt ? 'NAVI' : undefined}
                executedAt={msg.executedAt}
              />
            )
          }
          return (
            <div className="space-y-4">
              <NaviCard payload={msg.payload} intentType={it} onSign={onSign} onCancel={onReset} />
              {msg.text && <GeneralCard message={msg.text} />}
            </div>
          )
        }
        if (it === 'check_price') return (
          <PriceCard
            token={msg.payload?.token ?? ''}
            price={msg.payload?.price ?? null}
            message={msg.text ?? ''}
          />
        )
        if (it === 'schedule' || it === 'dca') return <ScheduledCard payload={msg.payload} />
        if (it === 'conditional') return <ConditionCard payload={msg.payload} />
        if (it === 'explain_transaction') return <ExplainCard payload={msg.payload} />
        if (it === 'request_payment') return <PaymentCard payload={msg.payload} paymentId={msg.payload?.payment?.id} />
        if (it === 'onboard') {
          if (msg.payload?.needsFunding && !msg.executionDigest) {
            return (
              <div className="space-y-3">
                {msg.text && <GeneralCard message={msg.text} />}
                {msg.executionError && <p className="text-xs text-red-400">{msg.executionError}</p>}
                <button
                  onClick={onOnboardFundSign}
                  className="w-full py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 hover:border-purple-500/60 text-purple-300 text-xs font-semibold transition-colors"
                >
                  Confirm &amp; Fund Invite →
                </button>
              </div>
            )
          }
          return msg.payload?.inviteLink
            ? <InviteLinkCard payload={msg.payload} />
            : (msg.text ? <GeneralCard message={msg.text} /> : null)
        }

        if (it === 'batch_payment' || it === 'split_payment') {
          // After execution
          if (msg.executionDigest) {
            const bd = msg.payload?.batchData
            return (
              <BundleReceiptCard
                digest={msg.executionDigest}
                token={bd?.token ?? ''}
                amountPerPerson={bd?.amountPerPerson ?? 0}
                recipients={bd?.members ?? []}
                kind={it === 'split_payment' ? 'split' : 'batch'}
              />
            )
          }
          if (msg.executionError) return (
            <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-6 py-5 space-y-2">
              <div className="flex items-center gap-2"><span className="text-red-400">✕</span><span className="text-white font-semibold text-sm">Batch payment failed</span></div>
              <p className="text-xs text-red-300/70">{msg.executionError}</p>
            </div>
          )
          return (
            <div className="space-y-4">
              <BatchPaymentCard payload={msg.payload} onSign={onBatchSign} onCancel={onReset} />
              {msg.text && <GeneralCard message={msg.text} />}
            </div>
          )
        }

        if (it === 'manage_contacts' || it === 'manage_groups') {
          if (msg.text) return <GeneralCard message={msg.text} />
          return null
        }

        if (it === 'send') {
          const p = msg.payload?.ptbParams as { token?: string; amount?: number; recipient?: string; contactName?: string } | undefined
          if (msg.executionDigest) {
            const dest = p?.contactName
              ?? (p?.recipient ? `${p.recipient.slice(0, 8)}…${p.recipient.slice(-4)}` : undefined)
            return (
              <TransactionReceiptCard
                digest={msg.executionDigest}
                title={`Sent ${p?.amount ?? ''} ${p?.token ?? ''}`.trim()}
                fromLabel={p?.amount ? `${p.amount} ${p.token ?? ''}`.trim() : undefined}
                toLabel={dest}
                executedAt={msg.executedAt}
              />
            )
          }
          if (msg.executionError) return (
            <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-6 py-5 space-y-2">
              <div className="flex items-center gap-2"><span className="text-red-400">✕</span><span className="text-white font-semibold text-sm">Transfer failed</span></div>
              <p className="text-xs text-red-300/70">{msg.executionError}</p>
            </div>
          )
          return (
            <div className="space-y-3">
              {msg.text && <GeneralCard message={msg.text} />}
              {p?.recipient && (
                <div className="flex gap-2">
                  <button
                    onClick={onSendSign}
                    className="flex-1 py-2 rounded-lg bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 hover:border-purple-500/60 text-purple-300 text-xs font-semibold transition-colors"
                  >
                    Confirm &amp; Send {p.amount} {p.token} →
                  </button>
                  <button
                    onClick={onReset}
                    className="px-4 py-2 rounded-lg bg-white/[0.02] hover:bg-red-500/10 border border-white/10 hover:border-red-500/40 text-slate-400 hover:text-red-300 text-xs font-semibold transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )
        }

        // Default text card
        if (msg.text) return <GeneralCard message={msg.text} />
        return null
      })()}
    </div>
  )
}

/* ─── Alert banner ───────────────────────────────────────────────────────── */

interface AlertBannerProps {
  alerts:    any[]
  onDismiss: () => void
  onExecute: (text: string) => void
}

function AlertBanner({ alerts, onDismiss, onExecute }: AlertBannerProps) {
  if (alerts.length === 0) return null
  const latest = alerts[alerts.length - 1]
  const color  = latest.severity === 'critical' ? 'border-red-500/40 bg-red-500/5 text-red-300'
               : latest.severity === 'warning'  ? 'border-yellow-500/40 bg-yellow-500/5 text-yellow-300'
               : 'border-purple-500/20 bg-purple-500/5 text-purple-300'

  // Severity icon — no emoji, pure SVG
  const Icon = latest.severity === 'critical'
    ? () => <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 100 20A10 10 0 0012 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    : latest.severity === 'warning'
    ? () => <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
    : () => <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a10 10 0 100-20 10 10 0 000 20zm1-7h-2v-6h2v6zm0-8h-2V5h2v2z"/></svg>

  return (
    <div className={`mx-4 mt-2 px-4 py-3 rounded-xl border flex items-start gap-3 ${color}`}>
      <Icon />
      <div className="flex-1 min-w-0">
        <p className="text-xs leading-relaxed">{latest.message}</p>
        {alerts.length > 1 && <p className="text-[10px] opacity-60 mt-1">+{alerts.length - 1} more alerts</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {latest.action && (
          <button
            onClick={() => { onExecute(latest.action); onDismiss() }}
            className="text-[10px] font-semibold px-2 py-1 rounded bg-purple-600/30 hover:bg-purple-600/60 text-purple-200 transition-colors"
          >
            Execute
          </button>
        )}
        <button onClick={onDismiss} className="text-[10px] opacity-40 hover:opacity-80">✕</button>
      </div>
    </div>
  )
}

/* ─── Slash commands definition ─────────────────────────────────────────── */

/* ─── Full feature list — shown when user types / ─────────────────────────── */

interface FeatureEntry {
  starter:  string   // what gets typed into the input — just the command word(s)
  label:    string   // one-line description of what it does
  hint:     string   // usage hint shown in grey — NOT inserted, just a guide
  category: string
}

const ALL_FEATURES: FeatureEntry[] = [
  // ── Swap & Trading ──────────────────────────────────────────────────────
  { category: 'Swap',       starter: 'Swap ',        label: 'Exchange one token for another',            hint: 'e.g. Swap 1 SUI to USDC'                         },
  { category: 'Swap',       starter: 'Buy ',          label: 'Buy a token or memecoin',                  hint: 'e.g. Buy LOFI with 10 USDC'                      },
  { category: 'Swap',       starter: 'Sell ',         label: 'Sell a token or exit a position',          hint: 'e.g. Sell my BLUB'                               },
  { category: 'Swap',       starter: 'Rebalance ',    label: 'Rebalance portfolio to target weights',    hint: 'e.g. Rebalance to 50% SUI 50% USDC'              },
  { category: 'Swap',       starter: 'Compound ',     label: 'Reinvest yield or rewards automatically',  hint: 'e.g. Compound my rewards on Cetus'               },
  { category: 'Swap',       starter: 'Exit ',         label: 'Exit a position entirely',                 hint: 'e.g. Exit my SUI position'                       },
  // ── NAVI ────────────────────────────────────────────────────────────────
  { category: 'NAVI',       starter: 'Lend ',         label: 'Supply assets to NAVI to earn yield',      hint: 'e.g. Lend 100 USDC on NAVI'                      },
  { category: 'NAVI',       starter: 'Borrow ',       label: 'Borrow against your collateral',           hint: 'e.g. Borrow 50 USDC from NAVI'                   },
  { category: 'NAVI',       starter: 'Repay ',        label: 'Repay borrowed debt on NAVI',              hint: 'e.g. Repay 50 USDC on NAVI'                      },
  { category: 'NAVI',       starter: 'Check health factor', label: 'View your liquidation safety score', hint: 'just send as-is'                                 },
  { category: 'NAVI',       starter: 'Check positions', label: 'See all open NAVI positions',            hint: 'just send as-is'                                 },
  // ── Automation ──────────────────────────────────────────────────────────
  { category: 'Automate',   starter: 'DCA ',          label: 'Dollar-cost average into an asset',        hint: 'e.g. DCA 10 USDC into SUI every day for 30 days' },
  { category: 'Automate',   starter: 'Schedule ',     label: 'Schedule a recurring or future action',    hint: 'e.g. Schedule swap 1 SUI to USDC every Friday'   },
  { category: 'Automate',   starter: 'Send ',         label: 'Send tokens — once or on a schedule',      hint: 'e.g. Send 5 USDC to 0x... every month'           },
  // ── Conditions ──────────────────────────────────────────────────────────
  { category: 'Conditions', starter: 'Swap if ',      label: 'Trigger a swap when a price condition hits', hint: 'e.g. Swap SUI to USDC if SUI drops below $3'   },
  { category: 'Conditions', starter: 'Buy if ',       label: 'Buy when a price target is reached',       hint: 'e.g. Buy SUI if SUI goes above $5'               },
  { category: 'Conditions', starter: 'Exit if ',      label: 'Auto-exit a position on a condition',      hint: 'e.g. Exit my LOFI if health factor drops below 1.5' },
  { category: 'Conditions', starter: 'Buy ',          label: 'Buy with auto profit-exit or stop-loss',   hint: 'e.g. Buy LOFI and exit at 20% profit / stop loss at 15%' },
  // ── Portfolio ────────────────────────────────────────────────────────────
  { category: 'Portfolio',  starter: 'Check balance', label: 'Show all your token balances',             hint: 'or: How much USDC do I have'                     },
  { category: 'Portfolio',  starter: 'Analyze ',      label: 'Deep AI analysis with recommendations',    hint: 'e.g. Analyze my wallet'                          },
  { category: 'Portfolio',  starter: 'Price of ',     label: 'Look up the current price of a token',     hint: 'e.g. Price of SUI'                               },
  { category: 'Portfolio',  starter: 'Explain ',      label: 'Explain any Sui transaction by digest',    hint: 'e.g. Explain transaction D8zRVk...'              },
  { category: 'Portfolio',  starter: 'Transaction history', label: 'Show your recent on-chain activity', hint: 'just send as-is'                                 },
  // ── Payments ─────────────────────────────────────────────────────────────
  { category: 'Payments',   starter: 'Send ',         label: 'Transfer tokens to a wallet address',      hint: 'e.g. Send 10 USDC to 0x...'                     },
  { category: 'Payments',   starter: 'Request ',      label: 'Generate a payment request link',          hint: 'e.g. Request payment of 50 USDC'                 },
  { category: 'Payments',   starter: 'Pay ',          label: 'Pay a saved contact by name',              hint: 'e.g. Pay Mum 50 USDC'                            },
  { category: 'Payments',   starter: 'Pay my ',       label: 'Batch-pay all members of a group',         hint: 'e.g. Pay my staff 200 USDC each'                 },
  { category: 'Payments',   starter: 'Split ',        label: 'Split an amount across a group equally',   hint: 'e.g. Split 1000 USDC among my contractors'       },
  // ── Contacts ─────────────────────────────────────────────────────────────
  { category: 'Contacts',   starter: '/contact add ', label: 'Save a wallet address as a named contact', hint: 'e.g. /contact add Mum 0x...'                     },
  { category: 'Contacts',   starter: '/contact list', label: 'List all your saved contacts',             hint: 'just send as-is'                                 },
  { category: 'Contacts',   starter: '/contact remove ', label: 'Remove a contact by name',              hint: 'e.g. /contact remove Mum'                        },
  // ── Groups ───────────────────────────────────────────────────────────────
  { category: 'Groups',     starter: '/group create ', label: 'Create a named group for batch payments', hint: 'e.g. /group create Staff with Alice, Bob'         },
  { category: 'Groups',     starter: '/group list',    label: 'List all your groups',                    hint: 'just send as-is'                                  },
  { category: 'Groups',     starter: '/group show ',   label: 'See who is in a group',                   hint: 'e.g. /group show Staff'                           },
  { category: 'Groups',     starter: '/group add ',    label: 'Add a member to an existing group',       hint: 'e.g. /group add Staff Dave 0x...'                 },
  // ── Onboard ──────────────────────────────────────────────────────────────
  { category: 'Onboard',    starter: '/onboard ',      label: 'Send a funded invite link to onboard a friend', hint: 'e.g. /onboard a friend with $5'             },
  // ── Chat ─────────────────────────────────────────────────────────────────
  { category: 'Chat',       starter: '/clear',         label: 'Clear the current conversation',           hint: 'wipes the chat — your History tab is untouched'  },
  { category: 'Chat',       starter: '/new',           label: 'Start a fresh chat',                       hint: 'same as /clear'                                  },
]

const CATEGORY_ORDER = ['Swap', 'NAVI', 'Automate', 'Conditions', 'Portfolio', 'Payments', 'Contacts', 'Groups', 'Onboard', 'Chat']
const CATEGORY_COLOR: Record<string, string> = {
  Swap:       'text-purple-400',
  NAVI:       'text-emerald-400',
  Automate:   'text-blue-400',
  Conditions: 'text-yellow-400',
  Portfolio:  'text-cyan-400',
  Payments:   'text-orange-400',
  Contacts:   'text-pink-400',
  Groups:     'text-indigo-400',
  Onboard:    'text-teal-400',
  Chat:       'text-slate-400',
}

interface SlashMenuProps {
  filter:   string
  onSelect: (starter: string) => void
  onClose:  () => void
}

function SlashMenu({ filter, onSelect, onClose }: SlashMenuProps) {
  const q = filter.slice(1).toLowerCase().trim()

  const matches = q
    ? ALL_FEATURES.filter(f =>
        f.starter.toLowerCase().includes(q) ||
        f.label.toLowerCase().includes(q)   ||
        f.category.toLowerCase().includes(q)
      )
    : ALL_FEATURES

  if (matches.length === 0) return null

  const grouped: Record<string, FeatureEntry[]> = {}
  for (const cat of CATEGORY_ORDER) grouped[cat] = []
  for (const f of matches) {
    if (grouped[f.category]) grouped[f.category].push(f)
  }

  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 bg-[#0d0d12] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-30">
      <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between">
        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
          Vektor features · click to start
        </span>
        <button onClick={onClose} className="text-[10px] text-slate-700 hover:text-slate-400 leading-none">✕</button>
      </div>

      <div className="max-h-96 overflow-y-auto">
        {CATEGORY_ORDER.map(cat => {
          const items = grouped[cat]
          if (!items?.length) return null
          return (
            <div key={cat} className="border-b border-white/[0.04] last:border-0">
              <div className="px-4 pt-3 pb-1.5">
                <span className={`text-[9px] font-mono uppercase tracking-widest font-semibold ${CATEGORY_COLOR[cat]}`}>
                  {cat}
                </span>
              </div>
              {items.map(f => (
                <button
                  key={f.starter}
                  onClick={() => onSelect(f.starter)}
                  className="w-full flex items-baseline gap-3 px-4 py-2 hover:bg-white/[0.04] transition-colors text-left group"
                >
                  {/* Command word — what gets typed */}
                  <span className="text-sm text-white font-medium shrink-0">{f.starter.trim()}</span>
                  {/* Description */}
                  <span className="text-[11px] text-slate-500 group-hover:text-slate-400 transition-colors min-w-0 truncate">{f.label}</span>
                  {/* Usage hint — far right, grey */}
                  <span className="text-[10px] text-slate-700 shrink-0 hidden group-hover:inline font-mono">{f.hint}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Main App ───────────────────────────────────────────────────────────── */

export default function App() {
  const account                = useCurrentAccount()
  const { mutate: disconnect } = useDisconnectWallet()
  const { signedFetch }        = useAuthFetch()

  // zkLogin — Google OAuth-based Sui address (alternative to wallet connect)
  const zkLogin = useZkLogin()
  // Unified address: prefer hardware wallet, fall back to zkLogin session
  const effectiveAddress = account?.address ?? zkLogin.user?.address ?? null

  // SUI balance — refreshes every 30 s
  const { data: suiBalanceData } = useSuiClientQuery(
    'getBalance',
    { owner: account?.address ?? '', coinType: '0x2::sui::SUI' },
    { enabled: !!account, refetchInterval: 30_000 },
  )
  const suiBalance = suiBalanceData
    ? (Number(suiBalanceData.totalBalance) / 1e9).toFixed(2)
    : null

  // Wallet dropdown
  const [walletOpen,    setWalletOpen]    = useState(false)
  const walletRef                          = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!walletOpen) return
    function onOutside(e: MouseEvent) {
      if (walletRef.current && !walletRef.current.contains(e.target as Node)) setWalletOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [walletOpen])

  function copyAddress() {
    if (account) navigator.clipboard.writeText(account.address)
    setWalletOpen(false)
  }

  // Detect ?invite=TOKEN — show the WelcomePage until dismissed.
  // Also restore from localStorage: Google OAuth does a full-page redirect, which
  // wipes the ?invite= param from the URL. We save it before the redirect so the
  // claim can still fire after the OAuth callback reloads the page.
  const urlInviteToken  = new URLSearchParams(window.location.search).get('invite') ?? null
  const storedInviteToken = typeof window !== 'undefined' ? localStorage.getItem('pending-invite') : null
  const inviteToken     = (urlInviteToken ?? storedInviteToken) || undefined
  const [showWelcome, setShowWelcome] = useState(() => !!inviteToken)

  const [connectOpen,     setConnectOpen]     = useState(false)
  const [addrCopied,      setAddrCopied]      = useState(false)
  const [messages,        setMessages]        = useState<ChatMessage[]>([])
  const [input,           setInput]           = useState('')
  const [portfolio,       setPortfolio]       = useState<any>(null)
  const [alerts,          setAlerts]          = useState<any[]>([])
  const [isLoading,       setIsLoading]       = useState(false)
  const [incomingPayment, setIncomingPayment] = useState<any>(null) // from ?pay= URL param
  const [contactsOpen,    setContactsOpen]    = useState(false)
  const [showSlashMenu,   setShowSlashMenu]   = useState(false)
  const [currentPage,     setCurrentPage]     = useState<'chat' | 'echo'>('chat')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [inviteClaim, setInviteClaim] = useState<{ amount: number; tokenSymbol: string; digest: string } | null>(null)
  // Multi-step prompt chain awaiting a continue/stop decision after a step failed.
  const [pendingChain, setPendingChain] = useState<{ steps: string[]; nextIndex: number } | null>(null)
  const [echoAlerts,      setEchoAlerts]      = useState<EchoWsMessage[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  // Tracks the last text written by the mic so we don't overwrite manual edits
  const micTextRef = useRef('')

  const abortRef       = useRef<AbortController | null>(null)
  const textareaRef    = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { mutate: signAndExecuteTransaction } = useSignAndExecuteTransaction()

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // Feature 9: read ?pay=<id> from URL on mount and pre-load payment details
  useEffect(() => {
    const payId = new URLSearchParams(window.location.search).get('pay')
    if (!payId) return
    fetch(`/api/payment/${payId}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.payment) {
          setIncomingPayment(d.payment)
          // Clean the URL so refreshing doesn't re-trigger
          window.history.replaceState({}, '', window.location.pathname)
        }
      })
      .catch(() => {})
  }, [])

  // On wallet/zkLogin sign-in: fetch portfolio + alerts + inject proactive welcome message
  useEffect(() => {
    if (!effectiveAddress) { setPortfolio(null); setAlerts([]); return }

    const wallet = effectiveAddress

    // Live portfolio fetch — only update state if we got real balances back (not an empty/failed response)
    fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet }) })
      .then(r => r.json())
      .then(d => {
        if (d.ok && (d.portfolio.balances?.length > 0 || d.portfolio.totalUsd > 0)) {
          setPortfolio(d.portfolio)
        }
      })
      .catch(() => {})

    // Memory: use stored snapshot instantly while live fetch runs, and build welcome message
    fetch(`/api/memory/${wallet}`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return
        const mem          = d.memory
        const dcaSummary   = d.dcaSummary  ?? []
        const priceContext = d.priceContext ?? {}

        // Pre-fill portfolio from memory snapshot so balance shows immediately
        if (mem.portfolioSnapshot?.balances?.length > 0) {
          setPortfolio((prev: any) => prev ?? mem.portfolioSnapshot)
        }

        if (messages.length === 0) {
          const parts: string[] = []

          // Portfolio value
          if (mem.portfolioSnapshot?.totalUsd) {
            parts.push(`Portfolio: $${mem.portfolioSnapshot.totalUsd.toFixed(2)}`)
          }

          // NAVI health factor with color hint
          if (mem.naviHealthFactor != null) {
            const hf   = mem.naviHealthFactor as number
            const hfLabel = hf > 2 ? '🟢' : hf > 1.5 ? '🟡' : '🔴'
            parts.push(`NAVI health: ${hfLabel} ${hf.toFixed(2)}`)
          }

          // DCA progress
          if (dcaSummary.length > 0) {
            const d0 = dcaSummary[0]
            parts.push(`DCA: ${d0.token} · ${d0.progress}`)
          }

          // Key prices
          const suiPrice = priceContext['SUI']
          if (suiPrice) parts.push(`SUI: $${suiPrice.toFixed(3)}`)

          // Intent count
          if ((mem.stats?.totalIntents ?? 0) > 0) {
            parts.push(`${mem.stats.totalIntents} intents total`)
          }

          if (parts.length > 0) {
            const firstName = zkLogin.user?.givenName?.trim() || null
            const greeting = mem.stats?.totalIntents > 0
              ? (firstName ? `Welcome back, ${firstName}.` : 'Welcome back.')
              : (firstName ? `Hey ${firstName} — wallet's ready.` : 'Wallet connected.')
            setMessages([{
              id:          crypto.randomUUID(),
              role:        'vektor',
              actionLabel: '· MEMORY · LOADED',
              text:        `${greeting} ${parts.join(' · ')}.`,
              intentType:  'general',
            }])
          }
        }
      })
      .catch(() => {})

  }, [effectiveAddress])

  // Poll for new alerts every 30 s (so scheduled payment notifications appear without reload)
  useEffect(() => {
    if (!effectiveAddress) return
    const wallet = effectiveAddress
    const poll = () => {
      fetch(`/api/alerts/${wallet}`)
        .then(r => r.json())
        .then(d => { if (d.ok && d.alerts.length) setAlerts(prev => [...prev, ...d.alerts]) })
        .catch(() => {})
    }
    poll() // fetch immediately on connect
    const interval = setInterval(poll, 30_000)
    return () => clearInterval(interval)
  }, [effectiveAddress])

  // Echo WebSocket — connect when wallet is active
  useEffect(() => {
    if (!effectiveAddress) { wsRef.current?.close(); wsRef.current = null; return }

    const echoWorkerUrl = (import.meta as any).env?.VITE_ECHO_WORKER_URL
    if (!echoWorkerUrl) return  // not configured yet — skip

    function connect() {
      const ws = new WebSocket(`${echoWorkerUrl}/ws/${effectiveAddress}`)
      wsRef.current = ws

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as EchoWsMessage
          setEchoAlerts(prev => [...prev.slice(-9), msg])  // keep last 10
        } catch { /* ignore malformed */ }
      }

      ws.onclose = () => {
        wsRef.current = null
        // Reconnect after 5 s
        setTimeout(connect, 5_000)
      }
    }

    connect()
    return () => { wsRef.current?.close(); wsRef.current = null }
  }, [effectiveAddress])

  // After Google OAuth, fire any pending invite claim silently and show a toast.
  useEffect(() => {
    const token = localStorage.getItem('pending-invite')
    if (!token || !effectiveAddress) return
    localStorage.removeItem('pending-invite')
    window.history.replaceState({}, '', window.location.pathname)
    fetch(`/api/onboard/${token}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipientAddress: effectiveAddress }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.digest) {
          setInviteClaim({ amount: d.amount, tokenSymbol: d.tokenSymbol ?? 'SUI', digest: d.digest })
        }
      })
      .catch(() => {})
  }, [effectiveAddress])

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }

  const refreshPortfolio = useCallback(() => {
    if (!effectiveAddress) return
    fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: effectiveAddress }) })
      .then(r => r.json())
      .then(d => {
        // Only update if we got real data — never overwrite a good portfolio with an empty one
        if (d.ok && (d.portfolio.balances?.length > 0 || d.portfolio.totalUsd > 0)) {
          setPortfolio(d.portfolio)
        }
      })
      .catch(() => {})
  }, [effectiveAddress])

  /* ── Stop current request ────────────────────────────────────────── */
  function stopRequest() {
    abortRef.current?.abort()
    abortRef.current = null
    setIsLoading(false)
    // Remove the pending vektor loading message
    setMessages(prev => prev.filter(m => !(m.role === 'vektor' && m.loading)))
  }

  /* ── Send message ─────────────────────────────────────────────────── */
  async function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    // ── Client-side chat commands — handled in the browser, never sent to the
    // model or the chain. These mirror the familiar /new · /clear convention.
    const cmd = trimmed.toLowerCase()
    if (cmd === '/clear' || cmd === '/new' || cmd === '/reset') {
      abortRef.current?.abort()
      abortRef.current = null
      setMessages([])
      setInput('')
      setIsLoading(false)
      setShowSlashMenu(false)
      setPendingChain(null)
      return
    }

    if (!effectiveAddress || isLoading) return

    // ── Multi-step chain: this message is a reply to "continue or stop?" ────
    if (pendingChain) {
      const chain = pendingChain
      setPendingChain(null)
      const wantsContinue = CHAIN_CONTINUE_RE.test(trimmed)
      const wantsStop     = CHAIN_STOP_RE.test(trimmed)
      if (wantsContinue || wantsStop) {
        setInput('')
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', text: trimmed }])
        if (wantsStop) {
          const remaining = chain.steps.length - chain.nextIndex
          setMessages(prev => [...prev, {
            id: crypto.randomUUID(), role: 'vektor', intentType: 'general',
            actionLabel: '· CHAIN · STOPPED',
            text: `Okay — stopped. ${remaining} remaining step${remaining === 1 ? '' : 's'} cancelled.`,
          }])
          return
        }
        await runChainFrom(chain.steps, chain.nextIndex)
        return
      }
      // Ambiguous reply — drop the stale chain and fall through to treat
      // this as a brand-new message instead of getting stuck.
    }

    // ── Multi-step chain: "swap all my WAL for SUI then send it to ebube" ───
    const chainSteps = splitChainSteps(trimmed)
    if (chainSteps.length > 1) {
      setInput('')
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', text: trimmed }])
      await runChainFrom(chainSteps, 0)
      return
    }

    const controller  = new AbortController()
    abortRef.current  = controller

    const userMsgId   = crypto.randomUUID()
    const vektorMsgId = crypto.randomUUID()

    setInput('')
    setIsLoading(true)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    setMessages(prev => [
      ...prev,
      { id: userMsgId,   role: 'user',   text: trimmed },
      { id: vektorMsgId, role: 'vektor', loading: true, actionLabel: '· PARSING · INTENT' },
    ])

    try {
      const res  = await fetch('/api/intent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: trimmed, senderAddress: effectiveAddress, firstName: zkLogin.user?.givenName ?? undefined }),
        signal:  controller.signal,
      })
      const raw  = await res.text()
      let json: any
      try { json = raw ? JSON.parse(raw) : {} }
      catch {
        const snippet = raw.slice(0, 120) || '(empty body)'
        throw new Error(
          res.status === 429 ? 'Rate limit reached — try again in a minute.' :
          res.status >= 500   ? `Server error (${res.status}). Try again.` :
          `Bad response from server (${res.status}): ${snippet}`,
        )
      }
      if (!json.ok) throw new Error(json.error ?? `Request failed (${res.status})`)

      const intentType = json.intent_type as string

      // Swap-type intents go through the Guardian flow
      const swapTypes = ['swap', 'compound', 'rebalance', 'risk_qualified', 'buy_memecoin', 'sell_memecoin', 'exit_at_profit', 'exit_at_loss', 'exit']

      // Per-device history: log on-chain actions (localStorage). Starts 'pending';
      // reportIntentStatus flips it to success/failed once signing completes.
      const writeIntents = new Set([...swapTypes, 'send', 'transfer', 'lend', 'borrow', 'repay', 'batch_payment', 'split_payment', 'pay'])
      if (writeIntents.has(intentType) && effectiveAddress) {
        const histId = json.recordId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        json.recordId = histId // keep message + status-report on the same id
        recordHistory(effectiveAddress, { id: histId, type: intentType, summary: trimmed, status: 'pending' })
      }

      if (swapTypes.includes(intentType) && json.quote && json.report) {
        setMessages(prev => prev.map(m =>
          m.id === vektorMsgId
            ? {
                ...m,
                loading:      false,
                language:     json.language ?? 'en',
                actionLabel:  intentType === 'swap' || intentType === 'compound' || intentType === 'rebalance' || intentType === 'risk_qualified'
                              ? buildSwapLabel(json.quote, json.report)
                              : json.actionLabel,
                originalText: trimmed,
                intentType,
                recordId:     json.recordId,
                guardData: {
                  parsedIntent: json.parsedIntent,
                  quote:        json.quote,
                  report:       json.report,
                  _rawReport:   json._rawReport,
                  quoteParams:  json.quoteParams,
                },
                phase: 'review' as const,
              }
            : m,
        ))
        setIsLoading(false)
        return
      }

      // All other intent types — rich card
      setMessages(prev => prev.map(m =>
        m.id === vektorMsgId
          ? {
              ...m,
              loading:     false,
              intentType,
              language:    json.language ?? 'en',
              actionLabel: json.actionLabel,
              text:        json.message,
              payload:     json,
              recordId:    json.recordId,
              phase:       undefined,
            }
          : m,
      ))

      // Refresh portfolio after lend/borrow/repay/send
      if (['lend', 'borrow', 'repay', 'send'].includes(intentType)) {
        setTimeout(refreshPortfolio, 3000)
      }

    } catch (err: any) {
      if (err?.name === 'AbortError') return // user cancelled — message already removed
      const errMsg = err instanceof Error ? err.message : 'Something went wrong'
      setMessages(prev => prev.map(m =>
        m.id === vektorMsgId
          ? { ...m, loading: false, actionLabel: '· ERROR', text: errMsg, intentType: 'error' }
          : m,
      ))
    } finally {
      setIsLoading(false)
      abortRef.current = null
    }
  }

  /* ── Run a single step of a multi-step chain ─────────────────────────
   * Mirrors the single-shot body of sendMessage, but (a) resolves "it"/
   * "that" against the previous step's actual on-chain output, (b) auto-
   * triggers the right signing handler instead of waiting for a button
   * click — the user already expressed intent for every step up front —
   * and (c) waits for the real execution result (not just "PTB built")
   * before telling the caller whether to advance to the next step. */
  async function runOneChainStep(
    stepText: string,
    stepIndex: number,
    totalSteps: number,
    priorOutcome?: { asset: string; amount: number },
  ): Promise<{ ok: boolean; error?: string; outcome?: { asset: string; amount: number } }> {
    let resolvedText = stepText
    if (priorOutcome && /\b(it|that)\b/i.test(stepText)) {
      resolvedText = stepText.replace(/\b(it|that)\b/i, `${priorOutcome.amount} ${priorOutcome.asset}`)
    }

    const vektorMsgId = crypto.randomUUID()
    setMessages(prev => [...prev, {
      id: vektorMsgId, role: 'vektor', loading: true,
      actionLabel: `· STEP ${stepIndex + 1}/${totalSteps} · PARSING`,
    }])

    try {
      const res  = await fetch('/api/intent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: resolvedText, senderAddress: effectiveAddress, firstName: zkLogin.user?.givenName ?? undefined }),
      })
      const raw  = await res.text()
      let json: any
      try { json = raw ? JSON.parse(raw) : {} }
      catch { throw new Error(`Bad response from server (${res.status})`) }

      if (!json.ok) {
        setMessages(prev => prev.map(m =>
          m.id === vektorMsgId ? { ...m, loading: false, actionLabel: '· ERROR', text: json.error ?? 'Step failed', intentType: 'error' } : m,
        ))
        return { ok: false, error: json.error ?? 'Step failed to parse' }
      }

      const intentType = json.intent_type as string
      const swapTypes   = ['swap', 'compound', 'rebalance', 'risk_qualified', 'buy_memecoin', 'sell_memecoin', 'exit_at_profit', 'exit_at_loss', 'exit']
      const writeIntents = new Set([...swapTypes, 'send', 'contact_payment', 'transfer', 'lend', 'borrow', 'repay', 'batch_payment', 'split_payment', 'pay'])

      if (writeIntents.has(intentType) && effectiveAddress) {
        const histId = json.recordId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        json.recordId = histId
        recordHistory(effectiveAddress, { id: histId, type: intentType, summary: resolvedText, status: 'pending' })
      }

      if (swapTypes.includes(intentType) && json.quote && json.report) {
        setMessages(prev => prev.map(m =>
          m.id === vektorMsgId
            ? {
                ...m, loading: false, language: json.language ?? 'en',
                actionLabel:  buildSwapLabel(json.quote, json.report),
                originalText: resolvedText, intentType, recordId: json.recordId,
                guardData: {
                  parsedIntent: json.parsedIntent, quote: json.quote, report: json.report,
                  _rawReport: json._rawReport, quoteParams: json.quoteParams,
                },
                phase: 'review' as const,
              }
            : m,
        ))
        const result = await handleConfirm(vektorMsgId)
        if (!result.ok) return { ok: false, error: result.error ?? 'Swap execution failed' }
        const amount = parseFloat(json.quote.amountOutFormatted ?? '0')
        return { ok: true, outcome: { asset: json.quote.toSymbol ?? json.parsedIntent?.output_goal ?? '', amount } }
      }

      // Rich card path (send, lend, borrow, repay, batch/split payment, etc.)
      setMessages(prev => prev.map(m =>
        m.id === vektorMsgId
          ? {
              ...m, loading: false, intentType, language: json.language ?? 'en',
              actionLabel: json.actionLabel, text: json.message, payload: json,
              recordId: json.recordId, phase: undefined,
            }
          : m,
      ))

      if (intentType === 'send' || intentType === 'contact_payment') {
        const p = json.ptbParams as { token?: string; amount?: number } | undefined
        const result = await handleSendSign(vektorMsgId)
        if (!result.ok) return { ok: false, error: result.error ?? 'Send execution failed' }
        return { ok: true, outcome: { asset: (p?.token ?? '').toUpperCase(), amount: p?.amount ?? 0 } }
      }
      if (intentType === 'lend' || intentType === 'borrow' || intentType === 'repay') {
        const result = await handleNaviSign(vektorMsgId)
        if (!result.ok) return { ok: false, error: result.error ?? 'Execution failed' }
        return { ok: true }
      }
      if (intentType === 'batch_payment' || intentType === 'split_payment') {
        const result = await handleBatchSign(vektorMsgId)
        if (!result.ok) return { ok: false, error: result.error ?? 'Execution failed' }
        return { ok: true }
      }

      // Read-only / no signing required (check_balance, check_price, etc.)
      return { ok: true }
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : 'Step failed'
      setMessages(prev => prev.map(m =>
        m.id === vektorMsgId ? { ...m, loading: false, actionLabel: '· ERROR', text: errMsg, intentType: 'error' } : m,
      ))
      return { ok: false, error: errMsg }
    }
  }

  /* ── Drive a multi-step chain sequentially, pausing to ask on failure ── */
  async function runChainFrom(
    steps: string[],
    startIndex: number,
    carryOutcome?: { asset: string; amount: number },
  ) {
    setIsLoading(true)
    let priorOutcome = carryOutcome
    try {
      for (let i = startIndex; i < steps.length; i++) {
        const result = await runOneChainStep(steps[i], i, steps.length, priorOutcome)
        if (!result.ok) {
          const hasMore = i + 1 < steps.length
          if (hasMore) setPendingChain({ steps, nextIndex: i + 1 })
          setMessages(prev => [...prev, {
            id: crypto.randomUUID(), role: 'vektor', intentType: 'general',
            actionLabel: '· STEP FAILED',
            text: hasMore
              ? `Step ${i + 1} of ${steps.length} failed to execute: ${result.error ?? 'unknown error'}.\n\nWant me to continue with step ${i + 2}, or stop here?`
              : `Step ${i + 1} of ${steps.length} failed to execute: ${result.error ?? 'unknown error'}.`,
          }])
          return
        }
        priorOutcome = result.outcome ?? priorOutcome
      }
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'vektor', intentType: 'general',
        actionLabel: '· CHAIN · COMPLETE',
        text: `All ${steps.length} steps completed.`,
      }])
    } finally {
      setIsLoading(false)
    }
  }

  /* ── Execute a due scheduled swap — calls /api/execute-scheduled/:id ─ */
  async function executeScheduled(scheduleId: string) {
    // Use effectiveAddress so zkLogin users (no dapp-kit `account`) work too.
    // signedFetch handles the auth: wallet-sig headers for Slush users,
    // session cookie for zkLogin users.
    if (!effectiveAddress) return

    const vektorMsgId = crypto.randomUUID()
    setIsLoading(true)
    setMessages(prev => [
      ...prev,
      { id: vektorMsgId, role: 'vektor', loading: true, actionLabel: '· SCHEDULED SWAP · PREPARING' },
    ])

    try {
      const res  = await signedFetch(`/api/execute-scheduled/${scheduleId}`, {
        method: 'POST',
        body:   JSON.stringify({ senderAddress: effectiveAddress }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error ?? 'Failed to prepare scheduled action')

      const intentType = json.intent_type as string

      if (intentType === 'send' || intentType === 'contact_payment') {
        // SEND path — drop a regular send confirmation card; the existing
        // handleSendSign flow reads payload.ptbParams to build + sign the PTB.
        setMessages(prev => prev.map(m =>
          m.id === vektorMsgId
            ? {
                ...m,
                loading:     false,
                intentType,
                language:    json.language ?? 'en',
                actionLabel: json.actionLabel,
                text:        json.message,
                payload:     json,
                phase:       undefined,
              }
            : m,
        ))
      } else {
        // SWAP / memecoin / etc — Guardian report + ConfirmationGate
        setMessages(prev => prev.map(m =>
          m.id === vektorMsgId
            ? {
                ...m,
                loading:      false,
                language:     json.language ?? 'en',
                actionLabel:  json.actionLabel,
                originalText: `Scheduled: ${json.parsedIntent?.input_asset} → ${json.parsedIntent?.output_goal}`,
                intentType:   'swap',
                guardData: {
                  parsedIntent: json.parsedIntent,
                  quote:        json.quote,
                  report:       json.report,
                  _rawReport:   json._rawReport,
                  quoteParams:  json.quoteParams,
                },
                phase: 'review' as const,
              }
            : m,
        ))
      }
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === vektorMsgId
          ? { ...m, loading: false, actionLabel: '· ERROR', text: err.message ?? 'Scheduled swap preparation failed', intentType: 'error' }
          : m,
      ))
    } finally {
      setIsLoading(false)
    }
  }

  /* ── Cancel — dismiss the confirmation gate entirely ──────────────── */
  function handleReset(msgId: string) {
    setMessages(prev => prev.map(m =>
      m.id === msgId
        ? {
            ...m,
            guardData:   undefined,       // hides PTBPreview + GuardianReport + ConfirmationGate
            phase:       undefined,
            text:        'Transaction cancelled.',
            intentType:  'general',
            actionLabel: '· CANCELLED',
          }
        : m
    ))
    // The record was logged 'pending' the moment /api/intent returned — without
    // this it stays stuck on 'pending' in History forever since the user never
    // signs anything for a cancelled confirmation.
    void reportIntentStatus(msgId, 'cancelled')
  }

  /* ── Build BCS bytes from a serialized PTB JSON, using the zkLogin address as sender ── */
  // Some endpoints (`/api/ptb`, `/api/batch-payment-ptb`, `/api/send-ptb`) return the
  // PTB as JSON (via `ptb.serialize()`). We reconstruct, set sender = zkLogin address,
  // and build the BCS bytes so they can be signed with the ephemeral key.
  const buildBytesFromPtbJson = useCallback(async (ptbJson: string): Promise<string> => {
    if (!effectiveAddress) throw new Error('Not signed in')
    const tx = Transaction.from(ptbJson)
    tx.setSender(effectiveAddress)
    const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet'), network: 'mainnet' })
    const bytes  = await tx.build({ client })
    return toBase64(bytes)
  }, [effectiveAddress])

  /* ── Sign NAVI transaction ────────────────────────────────────────── */
  /**
   * Report the final execution status of a write intent back to the server so
   * the History tab reflects reality. /api/intent leaves these records 'pending';
   * this flips them to success/failed once the browser finishes (or fails)
   * signing. Best-effort — a missing recordId or network error is non-fatal.
   * Skip when re-signing is in progress (NEED_RESIGN) — the record should stay
   * pending because execution will resume after the Google round-trip.
   */
  async function reportIntentStatus(msgId: string, status: 'success' | 'failed' | 'cancelled') {
    if (!effectiveAddress) return
    const recordId = messages.find(m => m.id === msgId)?.recordId
    if (!recordId) return
    updateHistoryStatus(effectiveAddress, recordId, status) // per-device history (authoritative)
    try {
      await fetch('/api/intent-status', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ wallet: effectiveAddress, recordId, status }),
      })
    } catch { /* History status is cosmetic — never block the user on it */ }
  }

  async function handleNaviSign(msgId: string): Promise<{ ok: boolean; error?: string }> {
    const msg = messages.find(m => m.id === msgId)
    if (!msg?.payload || !effectiveAddress) return { ok: false, error: 'Missing transaction data' }

    const intentType = msg.intentType ?? 'lend'
    const token  = (msg.payload.parsedIntent?.input_asset ?? 'SUI').toUpperCase()
    const amount = msg.payload.parsedIntent?.input_amount ?? 0

    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, actionLabel: '· SIGNING · ZKLOGIN' } : m
    ))

    try {
      // Always rebuild the PTB with the zkLogin address as sender — any cached
      // ptbB64 from /api/intent was built with the old sender claim and won't verify.
      const res = await fetch('/api/navi-ptb', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type: intentType, token, amount, sender: effectiveAddress }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error ?? 'Failed to build NAVI transaction')
      const ptbB64 = json.ptbB64 as string

      const digest = await zkLogin.signAndExecuteBytes(ptbB64)
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: '· EXECUTED · NAVI', executionDigest: digest, executedAt: Date.now() } : m
      ))
      void reportIntentStatus(msgId, 'success')
      setTimeout(refreshPortfolio, 3000)
      return { ok: true }
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const label  = isNeedResign(err) ? '· RE-SIGNING IN…' : '· FAILED'
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: label, text: isNeedResign(err) ? errMsg : `Transaction failed: ${errMsg}` } : m
      ))
      if (!isNeedResign(err)) void reportIntentStatus(msgId, 'failed')
      return { ok: false, error: errMsg }
    }
  }

  /* ── Batch / Split payment sign ──────────────────────────────────── */
  async function handleBatchSign(msgId: string): Promise<{ ok: boolean; error?: string }> {
    const msg = messages.find(m => m.id === msgId)
    if (!msg?.payload?.batchData || !effectiveAddress) return { ok: false, error: 'Missing transaction data' }

    const bd = msg.payload.batchData

    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, actionLabel: '· BUILDING · BATCH PTB' } : m
    ))

    try {
      const res  = await fetch('/api/batch-payment-ptb', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          senderAddress:   effectiveAddress,
          members:         bd.members,
          amountPerPerson: bd.amountPerPerson,
          token:           bd.token,
        }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error ?? 'Failed to build batch PTB')

      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: '· SIGNING · ZKLOGIN' } : m
      ))

      const txBytesB64 = await buildBytesFromPtbJson(json.ptbJson)
      const digest     = await zkLogin.signAndExecuteBytes(txBytesB64)
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: '· EXECUTED · BATCH', executionDigest: digest, executedAt: Date.now() } : m
      ))
      void reportIntentStatus(msgId, 'success')
      setTimeout(refreshPortfolio, 3000)
      return { ok: true }
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const label  = isNeedResign(err) ? '· RE-SIGNING IN…' : '· FAILED'
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: label, executionError: errMsg } : m
      ))
      if (!isNeedResign(err)) void reportIntentStatus(msgId, 'failed')
      return { ok: false, error: errMsg }
    }
  }

  /* ── Send (single-recipient transfer) ────────────────────────────── */
  async function handleSendSign(msgId: string): Promise<{ ok: boolean; error?: string }> {
    const msg = messages.find(m => m.id === msgId)
    const p   = msg?.payload?.ptbParams as { token?: string; amount?: number; recipient?: string } | undefined
    if (!msg || !effectiveAddress || !p?.token || !p?.amount || !p?.recipient) return { ok: false, error: 'Missing transaction data' }

    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, actionLabel: '· BUILDING · PTB' } : m
    ))

    try {
      const res = await fetch('/api/send-ptb', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          senderAddress: effectiveAddress,
          recipient:     p.recipient,
          token:         p.token,
          amount:        p.amount,
        }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error ?? 'Failed to build send PTB')

      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: '· SIGNING · ZKLOGIN' } : m
      ))

      const txBytesB64 = await buildBytesFromPtbJson(json.ptbJson)
      const digest     = await zkLogin.signAndExecuteBytes(txBytesB64)
      setMessages(prev => prev.map(m =>
        m.id === msgId ? {
          ...m,
          actionLabel:     `· SENT · ${p.amount} ${p.token}`,
          executionDigest: digest,
          executedAt:      Date.now(),
        } : m
      ))
      void reportIntentStatus(msgId, 'success')
      setTimeout(refreshPortfolio, 3000)
      return { ok: true }
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const label  = isNeedResign(err) ? '· RE-SIGNING IN…' : '· FAILED'
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: label, executionError: errMsg } : m
      ))
      if (!isNeedResign(err)) void reportIntentStatus(msgId, 'failed')
      return { ok: false, error: errMsg }
    }
  }

  /* ── Onboard — creator funds the invite (sent to Vektor's wallet, which
   *    forwards it in full to whoever claims the link) ────────────────── */
  async function handleOnboardFundSign(msgId: string): Promise<{ ok: boolean; error?: string }> {
    const msg         = messages.find(m => m.id === msgId)
    const p           = msg?.payload?.ptbParams as { token?: string; amount?: number; recipient?: string } | undefined
    const inviteToken = msg?.payload?.inviteToken as string | undefined
    if (!msg || !effectiveAddress || !p?.token || !p?.amount || !p?.recipient || !inviteToken) {
      return { ok: false, error: 'Missing funding data' }
    }

    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, actionLabel: '· BUILDING · PTB' } : m
    ))

    try {
      const res = await fetch('/api/send-ptb', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          senderAddress: effectiveAddress,
          recipient:     p.recipient,
          token:         p.token,
          amount:        p.amount,
        }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error ?? 'Failed to build funding transfer')

      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: '· SIGNING · ZKLOGIN' } : m
      ))

      const txBytesB64 = await buildBytesFromPtbJson(json.ptbJson)
      const digest      = await zkLogin.signAndExecuteBytes(txBytesB64)

      const confirmRes  = await fetch(`/api/onboard/${inviteToken}/fund-confirm`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ digest }),
      })
      const confirmJson = await confirmRes.json().catch(() => ({}))

      setMessages(prev => prev.map(m =>
        m.id === msgId ? {
          ...m,
          actionLabel:     '· FUNDED · INVITE READY',
          executionDigest: digest,
          executedAt:      Date.now(),
          payload:         { ...m.payload, inviteLink: confirmJson?.inviteLink ?? null },
        } : m
      ))
      void reportIntentStatus(msgId, 'success')
      setTimeout(refreshPortfolio, 3000)
      return { ok: true }
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const label  = isNeedResign(err) ? '· RE-SIGNING IN…' : '· FAILED'
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: label, executionError: errMsg } : m
      ))
      if (!isNeedResign(err)) void reportIntentStatus(msgId, 'failed')
      return { ok: false, error: errMsg }
    }
  }

  /* ── Fix (rewrite PTB) ────────────────────────────────────────────── */
  async function handleFix(msgId: string) {
    const msg = messages.find(m => m.id === msgId)
    if (!msg?.guardData) return

    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, phase: 'rewriting' as const } : m))

    try {
      const res  = await fetch('/api/rewrite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rawReport: msg.guardData!._rawReport }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error)

      // Route already optimal — no improvement possible, tell the user and restore review state
      if (json.improved === false) {
        setMessages(prev => prev.map(m =>
          m.id === msgId
            ? { ...m, phase: 'review' as const, guardData: { ...m.guardData!, diff: json.diff ?? null, rewriteNote: json.message } }
            : m,
        ))
        return
      }

      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, phase: 'rewritten' as const, actionLabel: buildRewriteLabel(json.quote, json.report), guardData: { ...m.guardData!, quote: json.quote, report: json.report, _rawReport: json._rawReport, diff: json.diff ?? null, rewriteNote: undefined } }
          : m,
      ))
    } catch (err: any) {
      const note = err instanceof Error ? err.message : 'Could not find a better route.'
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, phase: 'review' as const, guardData: { ...m.guardData!, rewriteNote: note } }
          : m,
      ))
    }
  }

  /* ── Confirm + execute on-chain ───────────────────────────────────── */
  async function handleConfirm(msgId: string): Promise<{ ok: boolean; error?: string }> {
    const msg = messages.find(m => m.id === msgId)
    if (!msg?.guardData?.quoteParams) return { ok: false, error: 'Missing transaction data' }

    // Show executing state
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, phase: 'confirmed' as const, loading: true, actionLabel: '· BUILDING · PTB' } : m,
    ))

    try {
      // Always quote with the zkLogin address as sender so the PTB binds to it.
      const params = { ...msg.guardData.quoteParams, sender: effectiveAddress ?? msg.guardData.quoteParams.sender }

      const ptbRes  = await fetch('/api/ptb', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(params),
      })
      const ptbJson = await ptbRes.json()
      if (!ptbJson.ok) throw new Error(ptbJson.error ?? 'Failed to build transaction')

      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, actionLabel: '· SIGNING · ZKLOGIN' } : m,
      ))

      const txBytesB64 = await buildBytesFromPtbJson(ptbJson.ptbJson)
      const digest     = await zkLogin.signAndExecuteBytes(txBytesB64)
      setMessages(prev => prev.map(m =>
        m.id === msgId ? {
          ...m,
          loading:         false,
          actionLabel:     '· EXECUTED · MAINNET',
          executionDigest: digest,
          executedAt:      Date.now(),
        } : m,
      ))
      void reportIntentStatus(msgId, 'success')
      setTimeout(refreshPortfolio, 3000)
      return { ok: true }
    } catch (err: any) {
      const errMsg = err.message ?? 'Execution failed.'
      const label = isNeedResign(err) ? '· RE-SIGNING IN…' : '· ERROR'
      setMessages(prev => prev.map(m =>
        m.id === msgId ? {
          ...m,
          loading:     false,
          phase:       'review' as const,
          actionLabel: label,
          text:        errMsg,
        } : m,
      ))
      if (!isNeedResign(err)) void reportIntentStatus(msgId, 'failed')
      return { ok: false, error: errMsg }
    }
  }

  const walletLabel = account
    ? `${account.address.slice(0, 6)}…${account.address.slice(-4)}`
    : null

  // ── Auth gate ─────────────────────────────────────────────────────────────
  // While /api/zklogin/me is in-flight, show nothing — avoids the 2-second
  // flash of LandingPage for users who are already signed in via Google.
  if (zkLogin.loading) return null

  if (!zkLogin.user) {
    // Not signed in — show WelcomePage (invite flow) or generic landing.
    if (showWelcome && inviteToken) {
      return (
        <WelcomePage
          token={inviteToken}
          onZkLogin={async () => {
            // Persist token before OAuth wipes the URL on redirect
            if (inviteToken) localStorage.setItem('pending-invite', inviteToken)
            await zkLogin.signIn()
          }}
          zkAvailable={true}
          onEnterApp={() => {
            localStorage.removeItem('pending-invite')
            window.history.replaceState({}, '', window.location.pathname)
            setShowWelcome(false)
          }}
        />
      )
    }
    return <LandingPage />
  }

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0f] overflow-hidden overflow-x-hidden">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="shrink-0 px-3 md:px-6 py-3 md:py-4 border-b border-white/5 flex items-center justify-between gap-2 bg-[#0a0a0f]/90 backdrop-blur-md z-20">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <VektorLogo className="h-6 md:h-7 w-auto text-white shrink-0" />
          <div className="hidden md:flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-slate-500 font-mono">mainnet</span>
          </div>
          {/* Nav links — hidden on mobile (Echo reachable via sidebar drawer) */}
          <nav className="hidden md:flex items-center gap-1 md:ml-2 shrink-0">
            {(['chat', 'echo'] as const).map(page => (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-widest transition-colors ${
                  currentPage === page
                    ? 'bg-purple-600/20 border border-purple-500/30 text-purple-300'
                    : 'text-slate-600 hover:text-slate-400'
                }`}
              >
                {page === 'echo' && echoAlerts.length > 0 && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 mr-1.5 mb-0.5 animate-pulse" />
                )}
                {page}
              </button>
            ))}
          </nav>
        </div>

        {account ? (
          <div className="flex items-center gap-1.5 md:gap-2">
            {/* Mobile hamburger — opens sidebar drawer (md:hidden) */}
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="md:hidden w-9 h-9 flex items-center justify-center rounded-lg border border-white/8 bg-[#111118] text-slate-400 hover:border-purple-500/30 hover:text-purple-300 transition-colors shrink-0"
              title="Portfolio"
              aria-label="Open sidebar"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            {/* Contacts button */}
            <button
              onClick={() => setContactsOpen(true)}
              className="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg border border-white/8 bg-[#111118] text-slate-500 hover:border-purple-500/30 hover:text-purple-300 transition-colors shrink-0"
              title="Contacts &amp; Groups"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
              </svg>
            </button>

          <div ref={walletRef} className="relative shrink-0">
            <button
              onClick={() => setWalletOpen(o => !o)}
              className="flex items-center gap-1.5 md:gap-2 px-2.5 md:px-3 h-9 md:h-auto md:py-2 rounded-lg border border-white/10 bg-[#111118] text-xs md:text-sm text-slate-300 hover:border-purple-500/40 hover:text-white transition-colors font-mono"
            >
              {/* $ value: desktop only — mobile keeps the pill compact */}
              {portfolio != null && (portfolio.balances?.length > 0 || portfolio.totalUsd > 0) ? (
                <>
                  <span className="hidden md:inline text-slate-300">${portfolio.totalUsd.toFixed(2)}</span>
                  <span className="hidden md:inline text-white/20 select-none">·</span>
                </>
              ) : (
                <>
                  <span className="hidden md:inline w-12 h-3 rounded bg-white/10 animate-pulse" />
                  <span className="hidden md:inline text-white/20 select-none">·</span>
                </>
              )}
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <span>{walletLabel}</span>
            </button>

            {walletOpen && (
              <div className="absolute right-0 top-full mt-2 w-44 rounded-xl border border-white/10 bg-[#111111] shadow-2xl z-50 overflow-hidden">
                <button
                  onClick={copyAddress}
                  className="w-full px-4 py-3 text-left text-sm text-slate-300 hover:bg-purple-500/10 hover:text-white transition-colors"
                >
                  Copy Address
                </button>
                <div className="border-t border-white/5" />
                <button
                  onClick={() => { disconnect(); setWalletOpen(false) }}
                  className="w-full px-4 py-3 text-left text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
          </div>
        ) : zkLogin.user ? (
          /* ── zkLogin session active — full chat header (hamburger + contacts + Google pill + sign-out) ─── */
          <div className="flex items-center gap-1.5 md:gap-2">
            {/* Mobile hamburger — opens sidebar drawer (md:hidden) */}
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="md:hidden w-9 h-9 flex items-center justify-center rounded-lg border border-white/8 bg-[#111118] text-slate-400 hover:border-purple-500/30 hover:text-purple-300 transition-colors shrink-0"
              title="Portfolio"
              aria-label="Open sidebar"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            {/* Contacts */}
            <button
              onClick={() => setContactsOpen(true)}
              className="w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg border border-white/8 bg-[#111118] text-slate-500 hover:border-purple-500/30 hover:text-purple-300 transition-colors shrink-0"
              title="Contacts &amp; Groups"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
              </svg>
            </button>
            {/* Google avatar — opens dropdown with address + copy + sign out */}
            <ZkAvatarMenu zkLogin={zkLogin} addrCopied={addrCopied} setAddrCopied={setAddrCopied} portfolio={portfolio} />
          </div>
        ) : (
          /* ── Not connected ─── */
          <div className="flex items-center gap-2">
            <button
              onClick={zkLogin.signIn}
              disabled={zkLogin.loading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 bg-white text-[#1a1a1a] text-xs font-semibold hover:bg-white/90 disabled:opacity-50 transition-colors"
              title="Sign in with Google (zkLogin)"
            >
              {/* Google G */}
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {zkLogin.loading ? 'Redirecting…' : 'Sign in with Google'}
            </button>
          </div>
        )}
      </header>

      {/* ── Alert banner ────────────────────────────────────────────── */}
      <AlertBanner
        alerts={alerts}
        onDismiss={() => setAlerts([])}
        onExecute={(action) => {
          if (action.startsWith('__EXEC__:')) {
            // Scheduled swap alert — route to Guardian review flow, not intent re-parse
            executeScheduled(action.slice('__EXEC__:'.length))
          } else {
            sendMessage(action)
          }
        }}
      />

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Echo page ─────────────────────────────────────────────── */}
        {currentPage === 'echo' && (
          <EchoPage wsAlerts={echoAlerts} address={effectiveAddress} />
        )}

        {/* ── Chat area (hidden when on Echo page) ────────────────── */}
        <div className={`flex-1 flex flex-col overflow-hidden ${currentPage !== 'chat' ? 'hidden' : ''}`}>
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">

              {/* Invite claim success toast */}
              {inviteClaim && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="text-sm text-emerald-300 font-semibold">
                      ✓ Your {inviteClaim.amount} {inviteClaim.tokenSymbol} has arrived.
                    </p>
                    <p className="text-[10px] font-mono text-emerald-400/60">tx: {inviteClaim.digest}</p>
                  </div>
                  <button onClick={() => setInviteClaim(null)} className="text-slate-600 hover:text-slate-400 text-xs shrink-0">✕</button>
                </div>
              )}

              {/* Feature 9: Incoming payment card from ?pay= URL */}
              {incomingPayment && (
                <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-yellow-400">💸</span>
                      <span className="text-sm font-semibold text-white">Payment Request</span>
                    </div>
                    <button onClick={() => setIncomingPayment(null)} className="text-slate-600 hover:text-slate-400 text-xs">✕</button>
                  </div>
                  <p className="text-xs text-slate-400">
                    Someone is requesting <span className="text-white font-semibold">{incomingPayment.amount} {incomingPayment.token}</span>
                    {incomingPayment.description ? ` for "${incomingPayment.description}"` : ''}.
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        if (!effectiveAddress) { void zkLogin.signIn(); return }
                        sendMessage(`Send ${incomingPayment.amount} ${incomingPayment.token} to ${incomingPayment.creatorWallet}`)
                        setIncomingPayment(null)
                      }}
                      className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition-colors"
                    >
                      {effectiveAddress ? `Pay ${incomingPayment.amount} ${incomingPayment.token}` : 'Sign in to Pay'}
                    </button>
                    <span className={`text-xs font-mono ${incomingPayment.status === 'paid' ? 'text-emerald-400' : 'text-yellow-400'}`}>
                      {incomingPayment.status === 'paid' ? '✓ Already paid' : '⏳ Pending'}
                    </span>
                  </div>
                </div>
              )}

              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-24 gap-5 text-center select-none">
                  <VektorSymbol className="w-16 h-16 text-white opacity-90" />
                  <div className="space-y-2">
                    <p className="text-white font-semibold tracking-tight">
                      {zkLogin.user?.givenName
                        ? `Hey ${zkLogin.user.givenName} — what's the move?`
                        : 'Vektor — Financial OS for Sui'}
                    </p>
                    <p className="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
                      {effectiveAddress
                        ? 'Swap, lend, borrow, DCA, set conditions, analyze your wallet — all in plain English.'
                        : 'Sign in with Google to start talking to Vektor.'}
                    </p>
                  </div>
                  {!effectiveAddress && (
                    <div className="flex flex-col items-center gap-3 mt-2">
                      <button
                        onClick={zkLogin.signIn}
                        disabled={zkLogin.loading}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-white/10 bg-white text-[#1a1a1a] text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-colors"
                      >
                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                        </svg>
                        {zkLogin.loading ? 'Redirecting to Google…' : 'Sign in with Google'}
                      </button>
                      {/* errors from the OAuth round-trip surface via ?error= URL param */}
                    </div>
                  )}
                </div>
              )}

              {messages.map(msg => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  onFix={() => handleFix(msg.id)}
                  onConfirm={() => handleConfirm(msg.id)}
                  onReset={() => handleReset(msg.id)}
                  onSign={() => handleNaviSign(msg.id)}
                  onBatchSign={() => handleBatchSign(msg.id)}
                  onSendSign={() => handleSendSign(msg.id)}
                  onOnboardFundSign={() => handleOnboardFundSign(msg.id)}
                />
              ))}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* ── Input area ─────────────────────────────────────────── */}
          <div className="shrink-0 border-t border-white/5 bg-[#0a0a0f]/90 backdrop-blur-md">
            <div className="max-w-3xl mx-auto px-4 py-4 space-y-3">
              <div className="flex gap-2 flex-wrap">
                {QUICK_ACTIONS.map(action => (
                  <button
                    key={action}
                    onClick={() => sendMessage(action)}
                    disabled={!effectiveAddress}
                    className="text-xs px-3 py-1.5 rounded-full bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-purple-300 transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
                  >
                    {action}
                  </button>
                ))}
              </div>

              <div className="relative">
                {/* Slash commands popup */}
                {showSlashMenu && effectiveAddress && (
                  <SlashMenu
                    filter={input}
                    onSelect={(starter) => {
                      setInput(starter)
                      setShowSlashMenu(false)
                      // Place cursor at end of the starter text
                      requestAnimationFrame(() => {
                        const el = textareaRef.current
                        if (el) { el.focus(); el.setSelectionRange(starter.length, starter.length) }
                      })
                    }}
                    onClose={() => setShowSlashMenu(false)}
                  />
                )}

                {!effectiveAddress && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[#0a0a0f]/60 backdrop-blur-sm z-10 pointer-events-none">
                    <span className="text-sm text-slate-500">Sign in to start</span>
                  </div>
                )}
                <div className="flex items-end gap-3 bg-[#111118] border border-white/8 rounded-2xl px-4 py-3 focus-within:border-purple-500/25 transition-colors min-h-[52px]">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => {
                      const v = e.target.value
                      micTextRef.current = v   // keep in sync so mic doesn't fight user edits
                      setInput(v)
                      autoResize(e.target)
                      // Show slash menu when input starts with /
                      setShowSlashMenu(v.startsWith('/') && v.length <= 40)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Escape') { setShowSlashMenu(false); return }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        setShowSlashMenu(false)
                        sendMessage(input)
                      }
                    }}
                    disabled={!effectiveAddress || isLoading}
                    placeholder={isLoading ? 'Processing…' : PLACEHOLDER}
                    rows={1}
                    // text-base (16px) on mobile prevents iOS zoom-on-focus; revert to text-sm at md+
                    className="flex-1 bg-transparent resize-none text-base md:text-sm text-white placeholder:text-slate-600 focus:outline-none leading-relaxed disabled:opacity-50"
                    style={{ maxHeight: '120px' }}
                  />
                  {isLoading ? (
                    /* ── Stop button ── */
                    <button
                      onClick={stopRequest}
                      className="shrink-0 w-11 h-11 md:w-8 md:h-8 rounded-lg bg-red-600/20 border border-red-500/30 hover:bg-red-600/40 hover:border-red-500/60 transition-all flex items-center justify-center"
                      title="Stop"
                    >
                      <svg className="w-3 h-3 text-red-400" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                      </svg>
                    </button>
                  ) : (
                    /* ── Mic + Send buttons ── */
                    <div className="flex items-center gap-1.5">
                      <MicButton
                        disabled={!effectiveAddress || isLoading}
                        wallet={effectiveAddress ?? undefined}
                        onLiveText={(text: string) => {
                          // Only overwrite if the user hasn't manually edited the field
                          setInput(prev => {
                            if (prev !== micTextRef.current) return prev  // user edited — leave it alone
                            micTextRef.current = text
                            return text
                          })
                          if (textareaRef.current) autoResize(textareaRef.current)
                        }}
                        onTranscription={(text: string) => {
                          // Final commit — always write, then clear the mic tracker
                          micTextRef.current = ''
                          setInput(text)
                          if (textareaRef.current) autoResize(textareaRef.current)
                          setTimeout(() => sendMessage(text), 2000)
                        }}
                      />
                      <button
                        onClick={() => sendMessage(input)}
                        disabled={!effectiveAddress || !input.trim()}
                        className="shrink-0 w-11 h-11 md:w-8 md:h-8 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-20 disabled:cursor-not-allowed transition-all flex items-center justify-center group"
                      >
                        <svg className="w-4 h-4 text-white transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <p className="text-center text-[10px] text-slate-700">
                Routex routing · Guardian v2 · NAVI · Sui mainnet
              </p>
            </div>
          </div>
        </div>

        {/* ── Sidebar ───────────────────────────────────────────────── */}
        <Sidebar
          wallet={effectiveAddress}
          portfolio={portfolio}
          onRefresh={refreshPortfolio}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          echoAlertCount={echoAlerts.length}
        />
      </div>

      {/* ── Contacts overlay ────────────────────────────────────────── */}
      {contactsOpen && effectiveAddress && (
        <ContactsPage
          wallet={effectiveAddress}
          onClose={() => setContactsOpen(false)}
        />
      )}
    </div>
  )
}
