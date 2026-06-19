/**
 * Live spot-check against the real /api/intent endpoint.
 *
 * Requires GROQ_API_KEY (the AI parser) and a running server on :3001.
 *  - If GROQ_API_KEY is unset → skip with a clear message (not a failure).
 *  - If server isn't reachable → skip.
 *  - The USDC→USDC case is the load-bearing assertion: it must NOT proceed
 *    to a swap quote. Other cases are printed as a behavior log.
 *
 *   npx tsx tests/intents.live.ts
 */

const SERVER = process.env.VEKTOR_URL ?? 'http://localhost:3001'
const SIM_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000001'

interface Probe { text: string; mustNotProceed?: boolean; note?: string }

const PROBES: Probe[] = [
  { text: 'send 0.1 USDC to USDC',       mustNotProceed: true,  note: 'original bug — must reject' },
  { text: 'swap 1 SUI for USDC',                                  note: 'proceeds (valid)' },
  { text: 'send 5 SUI to 0xabc',                                  note: 'proceeds' },
  { text: 'pay Mum 50 USDC',                                      note: 'proceeds or asks to add contact' },
  { text: 'swap 0 SUI to USDC',                                   note: 'reject (zero amount)' },
  { text: 'check my balance',                                     note: 'proceeds (read-only)' },
  { text: 'buy SUI if it drops below 0',                          note: 'reject (bad trigger)' },
  { text: 'explain transaction',                                  note: 'reject (no digest)' },
]

import * as fs from 'node:fs'
import * as path from 'node:path'

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

async function probe(p: Probe): Promise<{ status: number; body: any; err?: string }> {
  try {
    const r = await fetch(`${SERVER}/api/intent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: p.text, sender: SIM_SENDER }),
    })
    const body = await r.json().catch(() => ({}))
    return { status: r.status, body }
  } catch (err) {
    return { status: 0, body: {}, err: (err as Error).message }
  }
}

function summarise(body: any): string {
  if (body?.ok === false)  return `REJECT — ${String(body.error ?? '').slice(0, 80)}`
  if (body?.quote)         return 'PROCEED (swap quote returned)'
  if (body?.intent)        return `PROCEED (intent=${body.intent})`
  if (body?.text)          return `MESSAGE — ${String(body.text).slice(0, 80)}`
  return `OTHER — ${JSON.stringify(body).slice(0, 80)}`
}

async function main(): Promise<void> {
  loadEnv()

  if (!process.env.GROQ_API_KEY) {
    console.log('\nSKIP — GROQ_API_KEY not set; live LLM probe needs an AI key in .env.')
    process.exit(0)
  }

  // Reachability check
  try { await fetch(`${SERVER}/api/zklogin/epoch`) }
  catch {
    console.log(`\nSKIP — server not reachable at ${SERVER}. Start it first.`)
    process.exit(0)
  }

  console.log()
  console.log(`LIVE — POST ${SERVER}/api/intent  (${PROBES.length} probes)`)
  console.log('='.repeat(110))

  let usdcUsdcCaught = false
  for (const p of PROBES) {
    const r       = await probe(p)
    const summary = r.err ? `ERR — ${r.err}` : summarise(r.body)
    const proceeded = r.body?.ok !== false && (r.body?.quote || r.body?.intent || r.body?.payload)

    if (p.mustNotProceed && p.text.toLowerCase().includes('usdc to usdc')) {
      usdcUsdcCaught = !proceeded
    }

    const flag = p.mustNotProceed ? (proceeded ? '✗ MUST-NOT-PROCEED' : '✓ caught') : '·'
    console.log(`[${String(r.status).padStart(3)}]  ${flag.padEnd(20)}  ${p.text.padEnd(38)}  ${summary}`)
    if (p.note) console.log(`        note: ${p.note}`)
  }
  console.log('='.repeat(110))
  console.log()
  console.log(`USDC→USDC load-bearing gate: ${usdcUsdcCaught ? 'GREEN' : 'RED'}`)
  console.log()
  process.exit(usdcUsdcCaught ? 0 : 1)
}

void main()
