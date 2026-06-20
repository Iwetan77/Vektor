/**
 * WelcomePage — onboarding landing page.
 *
 * Shown when the URL contains a ?invite=TOKEN query parameter.
 * Handles two states:
 *   • Token present  → personalised invite (shows who invited the user)
 *   • No token       → generic Vektor intro page
 */

import { useEffect, useState } from 'react'

// ─── Feature cards ────────────────────────────────────────────────────────────

const FEATURES = [
  {
    title: 'Plain-English DeFi',
    body: 'Swap, lend, borrow, or DCA — just type what you want. No more juggling five different UIs.',
  },
  {
    title: 'Guardian AI',
    body: 'Every trade is scored for slippage, price impact, and protocol risk before you sign anything.',
  },
  {
    title: 'Automation',
    body: 'Set it and forget it — DCA schedules, price-triggered orders, and portfolio rebalancing on autopilot.',
  },
  {
    title: 'zkLogin',
    body: 'No seed phrase needed. Sign in with Google and get a self-custodial Sui address in seconds.',
  },
]

// ─── Vektor symbol (same one used on the landing & chat pages) ────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  token?:       string
  onZkLogin?:   () => void
  zkAvailable?: boolean
  onEnterApp?:  () => void
}

interface Invite {
  creatorWallet: string
  createdAt:     string
  amount:        number
  token_symbol:  string
  claimed:       boolean
}

export function WelcomePage({ token, onZkLogin, zkAvailable, onEnterApp }: Props) {
  const [invite, setInvite] = useState<Invite | null>(null)
  const [inviteLoading, setInviteLoading] = useState(!!token)

  useEffect(() => {
    if (!token) return
    fetch(`/api/onboard/${token}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setInvite(d.invite) })
      .catch(() => {})
      .finally(() => setInviteLoading(false))
  }, [token])

  const shortWallet = invite
    ? `${invite.creatorWallet.slice(0, 6)}…${invite.creatorWallet.slice(-4)}`
    : null

  // USDC reads naturally with a leading "$"; SUI (and anything else) does not.
  const fmtAmount = (amt: number, sym?: string) => {
    const s = (sym ?? 'USDC').toUpperCase()
    return s === 'USDC' ? `$${amt} USDC` : `${amt} ${s}`
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex flex-col items-center justify-center px-4 py-16">

      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <VektorSymbol className="w-10 h-10 text-purple-400" />
        <span className="text-2xl font-semibold tracking-tight text-white">Vektor</span>
      </div>

      {/* Invite banner */}
      {token && !inviteLoading && invite && (
        <div className="mb-8 px-5 py-3 rounded-full border border-purple-500/30 bg-purple-500/10 text-sm text-purple-300">
          <span className="font-mono text-white/60">{shortWallet}</span>
          {' '}invited you to Vektor with {fmtAmount(invite.amount, invite.token_symbol)}
        </div>
      )}


      {/* Headline */}
      <div className="text-center space-y-3 mb-12 max-w-lg">
        <h1 className="text-4xl font-bold tracking-tight text-white leading-tight">
          Your Financial OS<br />for Sui
        </h1>
        <p className="text-slate-400 text-base leading-relaxed">
          Trade, lend, automate, and manage your DeFi portfolio — all in plain English.
          Powered by AI. Guarded by zkLogin.
        </p>
      </div>

      {/* CTAs — Google sign-in only, Skip beneath it */}
      <div className="flex flex-col items-center gap-3 mb-14">
        {/* zkLogin Google sign-in */}
        {zkAvailable && onZkLogin && (
          <button
            onClick={onZkLogin}
            className="flex items-center gap-2.5 px-6 py-3 rounded-xl border border-white/10 bg-white text-[#1a1a1a] text-sm font-semibold hover:bg-white/90 transition-colors"
          >
            {/* Google "G" logo */}
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </button>
        )}

        {/* Skip straight to app */}
        {onEnterApp && (
          <button
            onClick={onEnterApp}
            className="text-sm text-slate-500 hover:text-slate-300 transition-colors underline underline-offset-2"
          >
            Skip — explore without connecting
          </button>
        )}
      </div>

      {/* Feature grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl w-full">
        {FEATURES.map(f => (
          <div
            key={f.title}
            className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-2"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-semibold text-white">{f.title}</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>

      {/* Footer */}
      <p className="mt-12 text-xs text-slate-600">
        Vektor · Built on Sui Mainnet · Non-custodial
      </p>
    </div>
  )
}
