/**
 * Vektor landing — sole CTA: "Continue with Google" → zkLogin (built-in Sui wallet,
 * no seed phrase). Mobile-first, dark, generous negative space.
 *
 * Sections fade in on scroll via IntersectionObserver; no router, just a single
 * vertical document.
 */

import { useEffect, useRef, useState } from 'react'
import { useZkLogin } from './useZkLogin.js'

/* ─── Vektor symbol (same one used in the chat page) ──────────────────── */
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

function GoogleG({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}

/* ─── Reveal-on-scroll wrapper ────────────────────────────────────────── */
function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { setShown(true); io.disconnect() }
    }, { threshold: 0.12 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-700 ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
    >
      {children}
    </div>
  )
}

/* ─── Features ─────────────────────────────────────────────────────────── */
const FEATURES: Array<{ label: string; body: string }> = [
  { label: 'Natural-language intents', body: 'Swap, lend, send, schedule. Just type it.' },
  { label: 'Guardian risk checks',     body: 'Every transaction is scored and explained before you sign.' },
  { label: 'Echo autonomous agent',    body: 'Set rules; Echo watches your portfolio and acts on your behalf.' },
  { label: 'Multilingual',             body: 'Talk to Vektor in 15+ languages — including Yoruba, Hausa, Igbo, Swahili.' },
  { label: 'SuiNS sends',              body: 'Pay anyone by their name.sui — no copy-pasting 0x addresses.' },
  { label: '/onboard',                 body: 'Fund a friend\'s first wallet with one link. No seed phrase to lose.' },
]

/* ─── Landing ──────────────────────────────────────────────────────────── */
export function LandingPage() {
  const { signIn, loading } = useZkLogin()

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white antialiased overflow-x-hidden">
      {/* Subtle radial glow */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-60"
        style={{
          background: 'radial-gradient(ellipse 60% 40% at 30% 20%, rgba(147,51,234,0.15), transparent 70%)',
        }}
      />

      {/* ── Top bar ───────────────────────────────────────────────────── */}
      <header className="px-5 md:px-8 py-5 flex items-center justify-between max-w-6xl mx-auto">
        <div className="flex items-center gap-2.5">
          <VektorSymbol className="w-6 h-6 text-white" />
          <span className="font-mono text-sm tracking-widest text-slate-300">VEKTOR</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-mono text-slate-500">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          mainnet
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="px-5 md:px-8 pt-12 md:pt-24 pb-20 md:pb-32 max-w-6xl mx-auto">
        <div className="grid md:grid-cols-12 gap-10 md:gap-12 items-center">
          {/* Slogan */}
          <div className="md:col-span-7 space-y-6">
            <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-slate-500">
              · Financial OS for Sui ·
            </p>
            <h1 className="text-5xl md:text-7xl font-bold leading-[1.05] tracking-tight">
              Just say it.<br />
              <span className="text-purple-400">Vektor</span> does it.
            </h1>
            <p className="text-base md:text-lg text-slate-400 max-w-md leading-relaxed">
              Swap, lend, send, automate — on Sui, in plain English.
              Signed in by Google. Powered by zkLogin.
            </p>
          </div>

          {/* CTA */}
          <div className="md:col-span-5 space-y-4">
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6 md:p-7 space-y-5 backdrop-blur-sm">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-widest text-purple-400">
                  · CONTINUE ·
                </p>
                <h3 className="mt-2 text-xl font-semibold">Sign in for the full experience.</h3>
              </div>

              <button
                onClick={async () => {
                  try { await signIn() }
                  catch (err) {
                    console.error('[LandingPage] signIn failed:', err)
                    alert('Sign-in failed: ' + (err instanceof Error ? err.message : String(err)))
                  }
                }}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2.5 px-4 py-3.5 rounded-xl bg-white text-[#1a1a1a] font-semibold text-sm hover:bg-white/90 disabled:opacity-50 transition-colors min-h-[48px]"
              >
                <GoogleG className="w-4 h-4 shrink-0" />
                {loading ? 'Redirecting…' : 'Continue with Google'}
              </button>

              <ul className="text-xs text-slate-500 space-y-1.5 font-mono">
                <li>· Self-custody by default</li>
                <li>· No seed phrase to lose</li>
                <li>· Bound to your Gmail account</li>
              </ul>
            </div>
            <p className="text-[10px] font-mono text-slate-600 text-center">
              control plane ready · mainnet · Shinami zkProver
            </p>
          </div>
        </div>
      </section>

      {/* ── Features (reveal on scroll) ──────────────────────────────── */}
      <section className="px-5 md:px-8 pb-24 md:pb-40 max-w-4xl mx-auto space-y-12 md:space-y-16">
        <Reveal>
          <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-slate-500 text-center">
            · What you can say ·
          </p>
        </Reveal>

        {FEATURES.map((f, i) => (
          <Reveal key={f.label} delay={i * 60}>
            <div className="grid md:grid-cols-12 gap-3 md:gap-8 items-baseline border-b border-white/5 pb-8 md:pb-10">
              <div className="md:col-span-4">
                <p className="text-xs font-mono uppercase tracking-widest text-purple-400">· {String(i + 1).padStart(2, '0')}</p>
                <h3 className="text-xl md:text-2xl font-semibold mt-1.5">{f.label}</h3>
              </div>
              <p className="md:col-span-8 text-base md:text-lg text-slate-400 leading-relaxed">
                {f.body}
              </p>
            </div>
          </Reveal>
        ))}

        <Reveal>
          <div className="pt-8 text-center space-y-4">
            <p className="text-sm text-slate-500">Ready when you are.</p>
            <button
              onClick={() => { void signIn() }}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl bg-white text-[#1a1a1a] font-semibold text-sm hover:bg-white/90 disabled:opacity-50 transition-colors min-h-[48px]"
            >
              <GoogleG className="w-4 h-4 shrink-0" />
              {loading ? 'Redirecting…' : 'Continue with Google'}
            </button>
          </div>
        </Reveal>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="border-t border-white/5 px-5 md:px-8 py-6 max-w-6xl mx-auto flex items-center justify-between text-[10px] font-mono text-slate-600">
        <span>· Built on Sui mainnet</span>
        <span>· zkLogin · non-custodial</span>
      </footer>
    </div>
  )
}
