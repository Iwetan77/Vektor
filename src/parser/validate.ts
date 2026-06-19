/**
 * Post-parse validation gate. Runs AFTER parseIntent and BEFORE any handler
 * builds quotes / PTBs / executes. The LLM is allowed to be wrong; this layer
 * makes wrong intents fail fast with a friendly clarification instead of
 * silently turning a missing field into a no-op swap or a 500.
 *
 * Pure function: no I/O, no LLM, no chain. Deterministic — drives the
 * adversarial test suite in tests/intents.correctness.ts.
 */

import type { ParsedIntent, IntentType } from './types.js'

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; clarify: string }

const VALID_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>([
  'swap', 'compound', 'conditional', 'rebalance', 'risk_qualified', 'exit',
  'borrow', 'lend', 'repay', 'schedule', 'dca',
  'buy_memecoin', 'sell_memecoin', 'exit_at_profit', 'exit_at_loss',
  'send', 'contact_payment', 'batch_payment', 'split_payment', 'request_payment',
  'analyze_wallet', 'explain_transaction',
  'check_balance', 'check_positions', 'check_health_factor', 'check_price',
  'transaction_history', 'manage_contacts', 'manage_groups',
])

/** Token symbols a user might type instead of a recipient — mirrors server.ts. */
const KNOWN_TOKEN_SYMBOLS: ReadonlySet<string> = new Set([
  'SUI', 'USDC', 'USDT', 'WETH', 'WBTC', 'DEEP',
  'AFSUI', 'HASUI', 'VSUI', 'BUCK',
  'LOFI', 'BLUB', 'OCEAN', 'HIPPO', 'BONK', 'MEME',
])

/** Read-only / management intents — never require an amount. */
const NO_AMOUNT_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>([
  'check_balance', 'check_positions', 'check_health_factor', 'check_price',
  'transaction_history', 'analyze_wallet', 'explain_transaction',
  'manage_contacts', 'manage_groups', 'request_payment',
  'compound', 'rebalance', 'exit', 'risk_qualified',
])

/** Intents that require input_amount > 0. */
const AMOUNT_REQUIRED: ReadonlySet<IntentType> = new Set<IntentType>([
  'swap', 'send', 'contact_payment',
  'lend', 'borrow', 'repay',
  'dca', 'buy_memecoin', 'sell_memecoin',
  'batch_payment', 'split_payment',
])

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function reject(reason: string, clarify: string): ValidationResult {
  return { ok: false, reason, clarify }
}

export function validateIntent(intent: ParsedIntent): ValidationResult {
  // ── Universal ────────────────────────────────────────────────────────
  if (!VALID_INTENTS.has(intent.intent_type)) {
    return reject(
      `unknown intent_type "${intent.intent_type}"`,
      "I didn't catch what you wanted to do — try rephrasing?",
    )
  }

  if (isFiniteNumber(intent.confidence) && intent.confidence < 0.4) {
    return reject(
      `low confidence (${intent.confidence})`,
      "I'm not sure I understood that — could you rephrase?",
    )
  }

  const t = intent.intent_type

  // ── Amount rules ─────────────────────────────────────────────────────
  if (AMOUNT_REQUIRED.has(t)) {
    if (!isFiniteNumber(intent.input_amount)) {
      return reject(
        `${t} missing input_amount`,
        amountClarify(t),
      )
    }
    if (intent.input_amount <= 0) {
      return reject(
        `${t} non-positive input_amount (${intent.input_amount})`,
        amountClarify(t),
      )
    }
  }
  // Read-only/management intents: do not impose amount rules (regression guard).
  void NO_AMOUNT_INTENTS

  // ── Swap / memecoin trades ───────────────────────────────────────────
  if (t === 'swap' || t === 'buy_memecoin' || t === 'sell_memecoin') {
    if (!intent.input_asset) {
      return reject(`${t} missing input_asset`, 'Which token would you like to trade from?')
    }
    if (!intent.output_goal) {
      return reject(`${t} missing output_goal`, 'Which token would you like to receive?')
    }
    const a = intent.input_asset.trim().toUpperCase()
    const b = intent.output_goal.trim().toUpperCase()
    if (a === b) {
      return reject(
        `same-token swap (${a} → ${b})`,
        `Can't swap ${a} for itself — did you mean to send it to someone?`,
      )
    }
  }

  // ── Send / contact_payment ───────────────────────────────────────────
  if (t === 'send' || t === 'contact_payment') {
    if (!intent.input_asset) {
      return reject(`${t} missing input_asset`, 'Which token would you like to send?')
    }
    const recipient = (intent.recipient ?? '').trim()
    const recipientName = (intent.recipient_name ?? '').trim()

    // USDC→USDC bug class: "send 0.1 USDC to USDC" — recipient is a known
    // token symbol AND equals input_asset. Catch it with the same-token msg.
    if (recipient) {
      const upper = recipient.toUpperCase()
      const fromUpper = intent.input_asset.trim().toUpperCase()
      if (KNOWN_TOKEN_SYMBOLS.has(upper) && upper === fromUpper) {
        return reject(
          `${t} recipient is same token as input_asset (${upper})`,
          `Can't send ${upper} to itself — did you mean to send it to someone?`,
        )
      }
      // If recipient is a token symbol DIFFERENT from input_asset, that's the
      // legit send→swap reclassification — DO NOT block. Server handles it.
    }

    if (!recipient && !recipientName) {
      return reject(
        `${t} missing destination`,
        'Who should I send it to?',
      )
    }
  }

  // ── Conditional ──────────────────────────────────────────────────────
  if (t === 'conditional') {
    const tp = intent.constraints?.trigger_price
    if (!isFiniteNumber(tp) || tp <= 0) {
      return reject(
        `conditional missing/invalid trigger_price (${tp})`,
        'What price should I watch for? (e.g. "if SUI drops below 1.50")',
      )
    }
    const dir = intent.constraints?.trigger_direction
    if (dir !== 'above' && dir !== 'below') {
      return reject(
        `conditional missing trigger_direction`,
        'Should I trigger when the price goes above or below that level?',
      )
    }
  }

  // ── Exit at profit / loss ────────────────────────────────────────────
  if (t === 'exit_at_profit') {
    const pt = intent.profit_target
    if (!isFiniteNumber(pt) || pt <= 0) {
      return reject(
        `exit_at_profit missing/invalid profit_target (${pt})`,
        'What profit target should I exit at? (e.g. "20%")',
      )
    }
    // Allow up to 10 (1000%) but reject absurd values.
    if (pt > 10) {
      return reject(
        `exit_at_profit absurd profit_target (${pt})`,
        'That profit target looks too large — did you mean a percentage like 20%?',
      )
    }
  }
  if (t === 'exit_at_loss') {
    const sl = intent.stop_loss
    if (!isFiniteNumber(sl) || sl <= 0) {
      return reject(
        `exit_at_loss missing/invalid stop_loss (${sl})`,
        'What stop-loss level should I use? (e.g. "15%")',
      )
    }
    if (sl > 10) {
      return reject(
        `exit_at_loss absurd stop_loss (${sl})`,
        'That stop-loss looks too large — did you mean a percentage like 15%?',
      )
    }
  }

  // ── Schedule / DCA ───────────────────────────────────────────────────
  if (t === 'schedule' || t === 'dca') {
    const sched = intent.schedule
    if (!sched) {
      return reject(`${t} missing schedule`, 'How often should I run this? (daily, weekly, monthly, once)')
    }
    const validFreq = sched.frequency === 'daily' || sched.frequency === 'weekly' ||
                      sched.frequency === 'monthly' || sched.frequency === 'once'
    if (!validFreq) {
      return reject(
        `${t} invalid frequency (${sched.frequency})`,
        'Frequency must be one of: daily, weekly, monthly, once.',
      )
    }
    if (sched.minutesFromNow !== undefined && sched.minutesFromNow !== null) {
      if (!isFiniteNumber(sched.minutesFromNow) || sched.minutesFromNow <= 0 || sched.minutesFromNow >= 525600) {
        return reject(
          `${t} invalid minutesFromNow (${sched.minutesFromNow})`,
          'That delay looks wrong — it must be a positive number under a year.',
        )
      }
    }
    if (t === 'dca' && sched.runs !== undefined && sched.runs !== null) {
      if (!Number.isInteger(sched.runs) || sched.runs <= 0) {
        return reject(
          `dca invalid runs (${sched.runs})`,
          'How many DCA runs should I schedule? (a positive whole number)',
        )
      }
    }
  }

  // ── Explain transaction ──────────────────────────────────────────────
  if (t === 'explain_transaction') {
    const d = (intent.tx_digest ?? '').trim()
    if (!d) {
      return reject('explain_transaction missing tx_digest', 'Which transaction? Paste the digest.')
    }
    // Sui digests are base58 ~43-46 chars; cheap sanity check.
    if (d.length < 32 || d.length > 100 || /[^A-Za-z0-9]/.test(d)) {
      return reject(
        `explain_transaction implausible digest (${d.slice(0, 20)}…)`,
        "That doesn't look like a valid transaction digest.",
      )
    }
  }

  // ── Batch / split payment ────────────────────────────────────────────
  if (t === 'batch_payment' || t === 'split_payment') {
    if (!intent.group_name && !(intent as any).recipients) {
      return reject(
        `${t} missing group_name and recipients`,
        'Which group should receive this payment? (e.g. "my staff")',
      )
    }
    // input_amount > 0 already enforced by AMOUNT_REQUIRED above.
  }

  return { ok: true }
}

function amountClarify(t: IntentType): string {
  switch (t) {
    case 'swap':            return 'How much would you like to swap?'
    case 'send':            return 'How much would you like to send?'
    case 'contact_payment': return 'How much would you like to pay?'
    case 'lend':            return 'How much would you like to lend?'
    case 'borrow':          return 'How much would you like to borrow?'
    case 'repay':           return 'How much would you like to repay?'
    case 'dca':             return 'How much per DCA run?'
    case 'buy_memecoin':    return 'How much would you like to buy?'
    case 'sell_memecoin':   return 'How much would you like to sell?'
    case 'batch_payment':   return 'How much should each recipient receive?'
    case 'split_payment':   return 'What total amount should I split?'
    default:                return 'How much?'
  }
}
