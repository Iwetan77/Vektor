/**
 * Feature-matrix smoke test.
 * Runs every demo phrase the user wants to show off through /api/intent and
 * reports PASS / FAIL per category. No on-chain execution — uses the
 * simulated sender so handlers stop before signing.
 *
 *   npx tsx tests/features.smoke.ts
 *   npx tsx tests/features.smoke.ts --only Swaps
 *
 * Needs:
 *   - server running on :3001 (and .start.sh has been called)
 *   - GROQ_API_KEY in .env (the LLM parser)
 *   - SMOKE_TEST_KEY in .env (bypasses rate limiter for the test run)
 *
 * Each row asserts what the response SHAPE should look like — not exact text,
 * because the LLM is non-deterministic. The matrix is structured so a green
 * run = every feature the user listed responds without error and matches
 * its category's expected response shape.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/* ── Env loader ─────────────────────────────────────────────────────────── */
function loadEnv(): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env')
    if (!fs.existsSync(envPath)) return
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch { /* ignore */ }
}
loadEnv()

const SERVER     = process.env.VEKTOR_URL ?? 'http://localhost:3001'
const SIM_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000001'
const SMOKE_KEY  = process.env.SMOKE_TEST_KEY ?? ''

/* ── Predicate vocabulary ───────────────────────────────────────────────── */
type Body = Record<string, any>

const isOk         = (b: Body) => b?.ok === true
const isReject     = (b: Body) => b?.ok === false
const hasIntent    = (t: string) => (b: Body) => isOk(b) && b.intent_type === t
const hasQuote     = (b: Body) => isOk(b) && (b.quote || b.payload || b.amountOut || b.ptb || b.ptbJson)
const hasPortfolio = (b: Body) => isOk(b) && !!b.portfolio
const hasMessage   = (b: Body) => isOk(b) && typeof b.message === 'string' && b.message.length > 0
const hasInvite    = (b: Body) => isOk(b) && typeof b.inviteLink === 'string'

/** Boolean OR over predicates */
const any  = (...fns: Array<(b: Body) => any>) => (b: Body) => fns.some(f => !!f(b))

/* ── Cases ─────────────────────────────────────────────────────────────── */
interface Case {
  text:    string
  expect:  (b: Body) => boolean
  note?:   string
}

const SUITES: Record<string, Case[]> = {
  /* ── Swaps & trading ───────────────────────────────────────────────── */
  'Swaps & trading': [
    { text: 'swap 1 SUI for USDC',                       expect: any(hasQuote, hasIntent('swap')),                        note: 'swap quote' },
    { text: 'send 5 SUI to USDC',                        expect: any(hasQuote, hasIntent('swap')),                        note: 'send→swap reclassification' },
    { text: 'swap 1 SUI to USDC with low slippage',      expect: any(hasQuote, hasIntent('swap'), hasIntent('risk_qualified')) },
    { text: 'swap 10 SUI to USDC with 30% slippage',     expect: any(hasQuote, hasIntent('swap'), isReject),               note: 'Guardian may block but parser must reach swap' },
    { text: 'rebalance my portfolio to 50/50 SUI and USDC', expect: any(hasIntent('rebalance'), hasQuote) },
    { text: 'swap 5 SUI to USDC, nothing risky',         expect: any(hasIntent('risk_qualified'), hasIntent('swap'), hasQuote) },
    { text: 'compound my rewards',                       expect: any(hasIntent('compound'), hasMessage) },
  ],

  /* ── Memecoins ─────────────────────────────────────────────────────── */
  'Memecoins': [
    { text: 'buy 5 USDC of BLUB',                        expect: any(hasIntent('buy_memecoin'), hasQuote) },
    { text: 'sell my OCEAN',                             expect: any(hasIntent('sell_memecoin'), hasQuote, isReject) },
    { text: 'buy 10 USDC of LOFI and exit at 20% profit',expect: any(hasIntent('exit_at_profit'), hasIntent('buy_memecoin'), hasQuote) },
    { text: 'buy HIPPO with a 15% stop loss',            expect: any(hasIntent('exit_at_loss'), hasIntent('buy_memecoin'), hasQuote, isReject), note: 'missing amount may reject — acceptable' },
  ],

  /* ── NAVI ──────────────────────────────────────────────────────────── */
  'NAVI lending': [
    { text: 'deposit 5 SUI on NAVI',                     expect: any(hasIntent('lend'), hasMessage) },
    { text: 'lend 20 USDC on NAVI',                      expect: any(hasIntent('lend'), hasMessage) },
    { text: 'borrow 20 USDC',                            expect: any(hasIntent('borrow'), hasMessage) },
    { text: 'repay 20 USDC',                             expect: any(hasIntent('repay'), hasMessage) },
    { text: 'check my health factor',                    expect: any(hasIntent('check_health_factor'), hasMessage) },
    { text: 'check my positions',                        expect: any(hasIntent('check_positions'), hasMessage) },
  ],

  /* ── Scheduling / DCA ─────────────────────────────────────────────── */
  'Scheduling & DCA': [
    { text: 'swap 0.03 SUI to USDC in 3 minutes',        expect: any(hasIntent('schedule'), hasMessage) },
    { text: 'DCA $50 into SUI every week',               expect: any(hasIntent('dca'), hasMessage) },
    { text: 'buy 5 USDC of SUI every day for 30 days',   expect: any(hasIntent('dca'), hasMessage) },
    { text: 'lend 10 USDC tomorrow at noon',             expect: any(hasIntent('schedule'), hasMessage) },
  ],

  /* ── Conditional ───────────────────────────────────────────────────── */
  'Conditional': [
    { text: 'sell half my SUI if price drops below $2',  expect: any(hasIntent('conditional'), hasMessage) },
    { text: 'buy SUI if it drops below $3',              expect: any(hasIntent('conditional'), hasMessage) },
  ],

  /* ── Payments / contacts / groups ──────────────────────────────────── */
  'Payments & contacts': [
    { text: '/contact list',                             expect: any(hasIntent('manage_contacts'), hasMessage) },
    { text: 'pay Mum 50 USDC',                           expect: any(hasIntent('contact_payment'), isReject), note: 'reject OK if Mum not saved' },
    { text: 'send 0.5 SUI to 0x' + 'a'.repeat(64),       expect: any(hasIntent('send'), hasQuote, hasMessage) },
    { text: 'request 25 USDC',                           expect: any(hasIntent('request_payment'), hasMessage) },
  ],

  /* ── Portfolio / read-only ─────────────────────────────────────────── */
  'Read-only': [
    { text: 'check my balance',                          expect: any(hasIntent('check_balance'), hasPortfolio, hasMessage) },
    { text: 'how many USDC do I have',                   expect: any(hasIntent('check_balance'), hasPortfolio, hasMessage) },
    { text: 'price of SUI',                              expect: any(hasIntent('check_price'), hasMessage) },
    { text: 'analyze my wallet',                         expect: any(hasIntent('analyze_wallet'), hasPortfolio, hasMessage) },
    { text: 'transaction history',                       expect: any(hasIntent('transaction_history'), hasMessage) },
  ],

  /* ── Validation guards (must reject) ───────────────────────────────── */
  'Validation guards': [
    { text: 'send 0.1 USDC to USDC',                     expect: isReject, note: 'USDC→USDC same token' },
    { text: 'swap 0 SUI to USDC',                        expect: isReject, note: 'zero amount' },
    { text: 'buy SUI if it drops below 0',               expect: isReject, note: 'bad trigger' },
    { text: 'explain transaction',                       expect: isReject, note: 'no digest' },
  ],

  /* ── Multilingual ──────────────────────────────────────────────────── */
  'Multilingual': [
    { text: 'échange 1 SUI contre USDC',                 expect: any(hasIntent('swap'), hasQuote) },
    { text: '1 SUIをUSDCに交換',                          expect: any(hasIntent('swap'), hasQuote) },
    { text: 'yi 1 SUI pelu USDC',                        expect: any(hasIntent('swap'), hasQuote) },
  ],

  /* ── Slash / onboard ───────────────────────────────────────────────── */
  'Slash commands': [
    { text: '/onboard a friend with $5',                 expect: any(hasInvite, hasMessage), note: 'returns invite link or asks to connect' },
  ],
}

/* ── Runner ────────────────────────────────────────────────────────────── */

const SPACING_MS = Number(process.env.SPACING_MS ?? 2500)
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function isGroqRateLimited(body: Body): boolean {
  const err = String(body?.error ?? '')
  return err.startsWith('429') || /rate limit/i.test(err) || /try again in/i.test(err)
}

async function probe(text: string): Promise<{ status: number; body: Body; err?: string; ms: number; tries: number }> {
  const t0 = Date.now()
  let tries = 0
  let last: { status: number; body: Body; err?: string } = { status: 0, body: {} }

  for (let attempt = 0; attempt < 3; attempt++) {
    tries++
    try {
      const r = await fetch(`${SERVER}/api/intent`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(SMOKE_KEY ? { 'x-smoke-key': SMOKE_KEY } : {}),
        },
        body: JSON.stringify({ text, senderAddress: SIM_SENDER }),
      })
      const body = await r.json().catch(() => ({}))
      last = { status: r.status, body }

      // Retry on Groq upstream rate limit
      if ((r.status === 500 || r.status === 429) && isGroqRateLimited(body)) {
        await sleep(8000 * (attempt + 1)); continue
      }
      return { ...last, ms: Date.now() - t0, tries }
    } catch (err) {
      last = { status: 0, body: {}, err: (err as Error).message }
      await sleep(2000)
    }
  }
  return { ...last, ms: Date.now() - t0, tries }
}

function brief(b: Body): string {
  if (b?.ok === false) return `REJECT: ${String(b.error ?? '').slice(0, 60)}`
  if (b?.intent_type)  return `intent=${b.intent_type}${b.quote ? ' +quote' : ''}${b.portfolio ? ' +portfolio' : ''}${b.message ? ' +msg' : ''}`
  return `(${Object.keys(b ?? {}).slice(0, 4).join(',')})`
}

async function main(): Promise<void> {
  const onlyArg = process.argv.find(a => a.startsWith('--only='))?.split('=')[1]
                ?? (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined)

  if (!process.env.GROQ_API_KEY) {
    console.log('\nSKIP — GROQ_API_KEY missing.\n')
    process.exit(0)
  }
  try { await fetch(`${SERVER}/api/zklogin/epoch`) }
  catch {
    console.log(`\nSKIP — server not reachable at ${SERVER}. Run .start.sh first.\n`)
    process.exit(0)
  }
  if (!SMOKE_KEY) {
    console.log('\nWARN — SMOKE_TEST_KEY not set; the rate limiter (10/min) may throttle this run.\n')
  }

  console.log()
  console.log(`FEATURES — ${SERVER}/api/intent`)
  console.log('='.repeat(110))

  const tally: Array<{ suite: string; pass: number; fail: number }> = []
  const fails: Array<{ suite: string; text: string; detail: string }> = []

  for (const [suite, cases] of Object.entries(SUITES)) {
    if (onlyArg && !suite.toLowerCase().includes(onlyArg.toLowerCase())) continue
    console.log(`\n── ${suite} ──`)
    let pass = 0, fail = 0
    for (const c of cases) {
      const r  = await probe(c.text)
      const ok = !r.err && c.expect(r.body)
      const mark = ok ? '✓' : '✗'
      const detail = r.err ? `ERR ${r.err}` : brief(r.body)
      const triesNote = r.tries > 1 ? ` (×${r.tries})` : ''
      console.log(`  ${mark}  [${String(r.status).padStart(3)}]  ${(r.ms + 'ms').padStart(7)}  ${c.text.padEnd(54)}  ${detail}${triesNote}`)
      if (c.note) console.log(`        · ${c.note}`)
      if (ok) pass++; else {
        fail++
        fails.push({ suite, text: c.text, detail })
      }
      await sleep(SPACING_MS)
    }
    tally.push({ suite, pass, fail })
  }

  console.log()
  console.log('='.repeat(110))
  console.log('SUMMARY')
  console.log('='.repeat(110))
  let totalPass = 0, totalFail = 0
  for (const t of tally) {
    const status = t.fail === 0 ? 'GREEN' : 'RED'
    console.log(`  ${status.padEnd(6)}  ${t.suite.padEnd(28)}  ${t.pass} pass · ${t.fail} fail`)
    totalPass += t.pass; totalFail += t.fail
  }
  console.log('-'.repeat(110))
  console.log(`  TOTAL: ${totalPass} pass, ${totalFail} fail`)
  if (fails.length) {
    console.log('\nFAILURES (re-test these manually before demo):')
    for (const f of fails) console.log(`  · [${f.suite}] "${f.text}"  →  ${f.detail}`)
  }
  console.log()
  process.exit(totalFail === 0 ? 0 : 1)
}

void main()
