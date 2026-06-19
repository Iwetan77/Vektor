/**
 * Same-token swap rejection smoke test.
 *
 *   POST /api/intent  { text: "send 0.1 USDC to USDC" }  →  ok: false
 *
 * The bug: the parser sometimes returns intent_type='send' with recipient='USDC'
 * (a known token symbol), which used to be silently reclassified as a wasteful
 * USDC→USDC swap. Both the reclassification path and the swap handler now reject.
 *
 * This test boots the FULL server (it parses NL with the LLM), so it needs the
 * usual server env (.env). It hits the live :3001 instance — start it first.
 */

import 'dotenv/config'
import assert from 'node:assert/strict'

const BASE = process.env.VEKTOR_API ?? 'http://localhost:3001'

async function main() {
  // Use a test address that won't trigger any wallet-specific side effects.
  const SIM = '0x0000000000000000000000000000000000000000000000000000000000000000'

  const r = await fetch(`${BASE}/api/intent`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text: 'send 0.1 USDC to USDC', senderAddress: SIM }),
  })
  const j = await r.json() as any
  console.log('  response:', JSON.stringify({ ok: j.ok, intent_type: j.intent_type, error: j.error?.slice(0, 80) }))

  // The result must either reject outright (ok:false), or be a 'send' that asks
  // for a recipient (general/intent_type='send' without an executable quote).
  // It must NOT be a quoted swap (no `quote`/`report` payload).
  const isReject = j.ok === false
  const isSendAskingRecipient =
    j.ok === true &&
    (j.intent_type === 'send' || j.intent_type === 'general') &&
    !j.quote && !j.report

  assert.ok(
    isReject || isSendAskingRecipient,
    `Expected a rejection or a clarification, got: ${JSON.stringify({ ok: j.ok, intent_type: j.intent_type, hasQuote: !!j.quote })}`,
  )
  // Hardest guarantee: it MUST NOT be a swap with a Routex quote.
  assert.ok(
    !(j.intent_type === 'swap' && j.quote),
    `Same-token swap was accepted! intent_type=${j.intent_type}, has quote=${!!j.quote}`,
  )

  console.log('\nsametoken smoke  GREEN')
}

main().catch((e) => { console.error('sametoken smoke  RED:', e.message); process.exit(1) })
