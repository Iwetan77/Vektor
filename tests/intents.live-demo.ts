/**
 * intents.live-demo — a SHORT, SPACED live check of the real Groq parse path
 * for the headline demo phrases plus deliberate human mistakes. Runs each probe
 * sequentially with a delay so a free-tier Groq key is not rate-limited.
 *
 * This complements (does not replace):
 *   • tests/intents.correctness.ts — deterministic validation, no Groq
 *   • tests/routes.smoke.ts        — structured routes, no Groq
 *
 * Run:  ./node_modules/.bin/tsx tests/intents.live-demo.ts
 * Env:  SPACING_MS (default 4000), VEKTOR_BASE (default http://127.0.0.1:3001)
 */

const BASE = process.env.VEKTOR_BASE ?? 'http://127.0.0.1:3001'
const SPACING_MS = Number(process.env.SPACING_MS ?? 4000)

// A real, zero-balance mainnet address used to exercise balance-guard paths.
const ZERO = '0xdead000000000000000000000000000000000000000000000000000000000abc'

type Probe = {
  label:   string
  text:    string
  sender?: string
  // assertion against the response
  expect:  (r: any) => boolean
  note:    string
}

const PROBES: Probe[] = [
  { label: 'swap', text: 'swap 1 SUI to USDC',
    expect: r => r.ok && r.intent_type === 'swap', note: 'core swap' },
  { label: 'send→swap reclass', text: 'send 5 SUI to USDC',
    expect: r => r.ok && r.intent_type === 'swap', note: '"to a token" is a swap, not a transfer' },
  { label: 'NAVI lend', text: 'deposit 5 SUI on NAVI',
    expect: r => r.ok && r.intent_type === 'lend', note: 'NAVI deposit' },
  { label: 'memecoin', text: 'buy 5 USDC of BLUB',
    expect: r => r.ok && r.intent_type === 'buy_memecoin', note: 'memecoin buy' },
  { label: 'conditional', text: 'sell my SUI if it drops below $2',
    expect: r => r.ok && r.intent_type === 'conditional', note: 'price trigger' },
  { label: 'DCA', text: 'DCA 50 USDC into SUI every week',
    expect: r => r.ok && (r.intent_type === 'dca' || r.intent_type === 'schedule'), note: 'recurring buy' },
  { label: 'scheduled send', text: 'send 0.001 SUI to adeniyi.sui in 1 minute',
    expect: r => r.ok && r.intent_type === 'schedule' && (r.parsedIntent?.recipient ?? '').includes('adeniyi'),
    note: 'schedule wrapping a SEND (recipient must survive)' },
  { label: 'read: price', text: 'price of SUI',
    expect: r => r.ok && r.intent_type === 'check_price', note: 'read-only price' },
  { label: 'read: analyze', text: 'analyze my wallet',
    expect: r => r.ok && r.intent_type === 'analyze_wallet', note: 'previously crashed UI — must parse clean' },
  { label: 'multilingual (FR)', text: 'échange 1 SUI contre USDC',
    expect: r => r.ok && r.intent_type === 'swap', note: 'French → swap' },

  // ── Deliberate human mistakes — must reject cleanly ──
  { label: 'MISTAKE same-token', text: 'swap USDC to USDC',
    expect: r => r.ok === false, note: 'USDC→USDC is a no-op' },
  { label: 'MISTAKE overdraft', text: 'send 999999 SUI to adeniyi.sui', sender: ZERO,
    expect: r => r.ok === false && /Insufficient/i.test(r.error ?? ''), note: 'send more than balance' },
]

async function probe(p: Probe): Promise<{ ok: boolean; detail: string }> {
  const body: any = { text: p.text }
  if (p.sender) body.senderAddress = p.sender
  try {
    const res = await fetch(`${BASE}/api/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const txt = await res.text()
    let json: any = null
    try { json = txt ? JSON.parse(txt) : null } catch { return { ok: false, detail: `non-JSON: ${txt.slice(0, 60)}` } }
    if (!json) return { ok: false, detail: 'empty body' }
    const pass = p.expect(json)
    const got  = json.ok === false ? `reject: ${(json.error ?? '').slice(0, 45)}` : `${json.intent_type}`
    return { ok: pass, detail: got }
  } catch (e: any) {
    return { ok: false, detail: `error: ${e.message?.slice(0, 50)}` }
  }
}

async function main() {
  console.log(`\nLIVE DEMO PROBES — ${BASE}  (spacing ${SPACING_MS}ms)`)
  console.log('='.repeat(96))
  let pass = 0
  const fails: string[] = []
  for (let i = 0; i < PROBES.length; i++) {
    const p = PROBES[i]
    const r = await probe(p)
    if (r.ok) pass++; else fails.push(`${p.label} — "${p.text}" → ${r.detail}`)
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${p.label.padEnd(22)} ${r.detail.padEnd(28)} · ${p.note}`)
    if (i < PROBES.length - 1) await new Promise(res => setTimeout(res, SPACING_MS))
  }
  console.log('='.repeat(96))
  console.log(`TOTAL: ${pass}/${PROBES.length} pass`)
  if (fails.length) {
    console.log('\nFAILURES:')
    fails.forEach(f => console.log(`  ✗ ${f}`))
    process.exit(1)
  }
  console.log('LIVE DEMO PROBES OK')
}

main().catch(e => { console.error(e); process.exit(1) })
