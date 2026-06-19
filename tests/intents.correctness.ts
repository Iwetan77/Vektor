/**
 * Deterministic adversarial test suite for src/parser/validate.ts.
 * No network, no LLM — constructs ParsedIntent objects by hand so every run
 * gives the same result.
 *
 *   npx tsx tests/intents.correctness.ts
 *
 * Each row asserts an EXPECTED outcome (reject | pass). Any deviation fails.
 */

import { validateIntent } from '../src/parser/validate.js'
import type { ParsedIntent, IntentType, ScheduleSpec } from '../src/parser/types.js'

type Outcome = 'reject' | 'pass'

interface Case {
  name:     string
  expected: Outcome
  intent:   ParsedIntent
}

function mk(partial: Partial<ParsedIntent> & { intent_type: IntentType }): ParsedIntent {
  return {
    language:       'en',
    input_asset:    null,
    input_amount:   null,
    output_goal:    null,
    recipient:      null,
    tx_digest:      null,
    profit_target:  null,
    stop_loss:      null,
    schedule:       null,
    constraints: {
      max_slippage:        null,
      risk_tolerance:      'medium',
      protocol_preference: null,
      conditional_trigger: null,
      trigger_price:       null,
      trigger_asset:       null,
      trigger_direction:   null,
    },
    inferred_steps: [],
    user_raw_input: '',
    confidence:     0.9,
    recipient_name: null,
    group_name:     null,
    ...partial,
  }
}

const CASES: Case[] = [
  // ── MUST REJECT ────────────────────────────────────────────────────────
  { name: 'swap USDC→USDC same token',
    expected: 'reject',
    intent: mk({ intent_type: 'swap', input_asset: 'USDC', output_goal: 'USDC', input_amount: 0.1 }) },

  { name: 'send USDC recipient="USDC" (disguised same-token)',
    expected: 'reject',
    intent: mk({ intent_type: 'send', input_asset: 'USDC', recipient: 'USDC', input_amount: 0.1 }) },

  { name: 'swap SUI→USDC amount=0',
    expected: 'reject',
    intent: mk({ intent_type: 'swap', input_asset: 'SUI', output_goal: 'USDC', input_amount: 0 }) },

  { name: 'swap SUI→USDC amount=-5',
    expected: 'reject',
    intent: mk({ intent_type: 'swap', input_asset: 'SUI', output_goal: 'USDC', input_amount: -5 }) },

  { name: 'swap amount=NaN',
    expected: 'reject',
    intent: mk({ intent_type: 'swap', input_asset: 'SUI', output_goal: 'USDC', input_amount: Number.NaN }) },

  { name: 'swap amount=null',
    expected: 'reject',
    intent: mk({ intent_type: 'swap', input_asset: 'SUI', output_goal: 'USDC', input_amount: null }) },

  { name: 'send amount=10, no recipient, no recipient_name',
    expected: 'reject',
    intent: mk({ intent_type: 'send', input_asset: 'SUI', input_amount: 10, recipient: null, recipient_name: null }) },

  { name: 'conditional trigger_price=null',
    expected: 'reject',
    intent: mk({ intent_type: 'conditional', constraints: {
      max_slippage: null, risk_tolerance: 'medium', protocol_preference: null,
      conditional_trigger: null, trigger_price: null, trigger_asset: 'SUI', trigger_direction: 'below',
    } }) },

  { name: 'conditional trigger_price=-2',
    expected: 'reject',
    intent: mk({ intent_type: 'conditional', constraints: {
      max_slippage: null, risk_tolerance: 'medium', protocol_preference: null,
      conditional_trigger: null, trigger_price: -2, trigger_asset: 'SUI', trigger_direction: 'below',
    } }) },

  { name: 'explain_transaction tx_digest=""',
    expected: 'reject',
    intent: mk({ intent_type: 'explain_transaction', tx_digest: '' }) },

  { name: 'dca runs=-3',
    expected: 'reject',
    intent: mk({ intent_type: 'dca', input_asset: 'SUI', output_goal: 'USDC', input_amount: 10,
      schedule: { frequency: 'weekly', runs: -3 } as ScheduleSpec }) },

  { name: 'schedule minutesFromNow=-10',
    expected: 'reject',
    intent: mk({ intent_type: 'schedule',
      schedule: { frequency: 'once', minutesFromNow: -10 } as ScheduleSpec }) },

  { name: 'confidence=0.2 (low)',
    expected: 'reject',
    intent: mk({ intent_type: 'swap', input_asset: 'SUI', output_goal: 'USDC', input_amount: 1, confidence: 0.2 }) },

  // ── MUST PASS ──────────────────────────────────────────────────────────
  { name: 'swap SUI→USDC amount=1',
    expected: 'pass',
    intent: mk({ intent_type: 'swap', input_asset: 'SUI', output_goal: 'USDC', input_amount: 1 }) },

  { name: 'send SUI amount=5 raw 0x recipient',
    expected: 'pass',
    intent: mk({ intent_type: 'send', input_asset: 'SUI', input_amount: 5,
      recipient: '0xabc1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' }) },

  { name: 'send SUI amount=5 SuiNS recipient',
    expected: 'pass',
    intent: mk({ intent_type: 'send', input_asset: 'SUI', input_amount: 5, recipient: 'adeniyi.sui' }) },

  { name: 'contact_payment USDC amount=50 recipient_name="Mum"',
    expected: 'pass',
    intent: mk({ intent_type: 'contact_payment', input_asset: 'USDC', input_amount: 50, recipient_name: 'Mum' }) },

  { name: 'send SUI recipient="USDC" amount=5 (legit send→swap reclassification)',
    expected: 'pass',
    intent: mk({ intent_type: 'send', input_asset: 'SUI', recipient: 'USDC', input_amount: 5 }) },

  { name: 'check_balance (no amount, read-only)',
    expected: 'pass',
    intent: mk({ intent_type: 'check_balance' }) },

  { name: 'manage_contacts (no amount, management)',
    expected: 'pass',
    intent: mk({ intent_type: 'manage_contacts' }) },

  { name: 'exit_at_profit profit_target=0.2',
    expected: 'pass',
    intent: mk({ intent_type: 'exit_at_profit', profit_target: 0.2 }) },

  { name: 'dca frequency=weekly runs=10',
    expected: 'pass',
    intent: mk({ intent_type: 'dca', input_asset: 'SUI', output_goal: 'USDC', input_amount: 10,
      schedule: { frequency: 'weekly', runs: 10 } as ScheduleSpec }) },

  { name: 'conditional trigger_price=2 direction=below',
    expected: 'pass',
    intent: mk({ intent_type: 'conditional', constraints: {
      max_slippage: null, risk_tolerance: 'medium', protocol_preference: null,
      conditional_trigger: null, trigger_price: 2, trigger_asset: 'SUI', trigger_direction: 'below',
    } }) },
]

/* ── Runner ────────────────────────────────────────────────────────────── */

let pass = 0
let fail = 0
const rows: Array<{ name: string; expected: Outcome; got: Outcome; detail: string; ok: boolean }> = []

for (const c of CASES) {
  const result = validateIntent(c.intent)
  const got: Outcome = result.ok ? 'pass' : 'reject'
  const ok = got === c.expected
  const detail = result.ok ? '' : (result as { ok: false; clarify: string }).clarify
  rows.push({ name: c.name, expected: c.expected, got, detail, ok })
  if (ok) pass++; else fail++
}

const W = 60
console.log()
console.log('CORRECTNESS — validateIntent')
console.log('='.repeat(90))
console.log('STATUS  EXPECTED  GOT      CASE'.padEnd(50) + '  DETAIL')
console.log('-'.repeat(90))
for (const r of rows) {
  const status = r.ok ? 'PASS  ' : 'FAIL  '
  const line = `${status}  ${r.expected.padEnd(8)}  ${r.got.padEnd(7)}  ${r.name}`
  const padded = line.length < W + 30 ? line.padEnd(W + 30) : line + '  '
  console.log(`${padded}${r.detail}`)
}
console.log('-'.repeat(90))
console.log(`TOTAL: ${pass} pass, ${fail} fail (${CASES.length} cases)`)
console.log()

process.exit(fail === 0 ? 0 : 1)
