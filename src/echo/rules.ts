/**
 * Echo Rules — parse plain-English rules into structured EchoRule objects.
 * Calls the same AI client used by the intent parser.
 */

import { complete }      from '../ai/client.js'
import type { EchoRule } from './types.js'

const RULE_SYSTEM = `You are a rule parser for Echo, an autonomous DeFi agent running on Sui blockchain.
Parse the user's plain-English rule into a structured JSON object.
Return ONLY valid JSON. No preamble. No markdown.

Supported rule types:
  health_factor      — "never let my health factor drop below X"
  balance_floor      — "always keep at least X [token] liquid / available"
  stop_loss          — "exit [token/position] if down more than X%"
  rebalance          — "rebalance to [X%/Y%] allocation when drift exceeds Z%"
  yield_optimization — "move idle stablecoins to yield automatically"
  custom             — anything that doesn't fit the above

FIRST decide whether the input is actually an automation rule. Greetings, small
talk, questions, thanks, or anything that is not a standing condition+action
("if/when X then do Y", "always keep…", "never let…") is NOT a rule.
If it is NOT a rule, return exactly:
{ "isRule": false, "interpretation": string (one friendly sentence telling the user this isn't a rule and giving one concrete example they could set) }

If it IS a rule, return this exact JSON shape:
{
  "isRule": true,
  "parsed": {
    "type": "health_factor" | "balance_floor" | "stop_loss" | "rebalance" | "yield_optimization" | "custom",
    "asset": string or null,
    "threshold": number or null,
    "action": string (one short sentence describing what Echo will do),
    "params": {} (any extra key/value pairs)
  },
  "interpretation": string (plain English: "Echo understood: ...")
}

Examples:
  "Never let my health factor drop below 1.5"
  → { "parsed": { "type": "health_factor", "asset": null, "threshold": 1.5, "action": "Repay debt on NAVI when health factor drops below 1.5", "params": {} }, "interpretation": "Echo will watch your NAVI health factor and propose a repayment when it falls below 1.5." }

  "Always keep at least 100 USDC liquid"
  → { "parsed": { "type": "balance_floor", "asset": "USDC", "threshold": 100, "action": "Alert when liquid USDC balance drops below 100", "params": {} }, "interpretation": "Echo will alert you if your liquid USDC drops below 100." }

  "Exit any memecoin down more than 25%"
  → { "parsed": { "type": "stop_loss", "asset": "memecoin", "threshold": 0.25, "action": "Exit memecoin positions when PnL drops below -25%", "params": { "assetClass": "memecoin" } }, "interpretation": "Echo will exit any memecoin position if its loss exceeds 25%." }

  "Rebalance to 50/50 SUI and USDC when drift exceeds 10%"
  → { "parsed": { "type": "rebalance", "asset": null, "threshold": 0.10, "action": "Rebalance portfolio to 50% SUI / 50% USDC when drift exceeds 10%", "params": { "targets": { "SUI": 0.5, "USDC": 0.5 } } }, "interpretation": "Echo will rebalance to an equal SUI/USDC split whenever the portfolio drifts more than 10% from that target." }
`

export async function parseRule(raw: string): Promise<{
  isRule:          boolean
  parsed?:         EchoRule['parsed']
  interpretation:  string
}> {
  const response = await complete({
    system:    RULE_SYSTEM,
    prompt:    raw,
    maxTokens: 512,
    jsonMode:  true,
  })

  const cleaned = response
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  const obj = JSON.parse(cleaned)

  // Guard: the model decided this isn't a rule (greeting, question, chit-chat).
  // Don't fabricate a "custom" rule — tell the caller so it can reply naturally.
  if (obj.isRule === false || !obj.parsed) {
    return {
      isRule:         false,
      interpretation: obj.interpretation
        ?? "That doesn't look like an automation rule. Try something like \"exit any memecoin down more than 25%\" or \"never let my health factor drop below 1.5\".",
    }
  }

  return {
    isRule:         true,
    parsed:         obj.parsed,
    interpretation: obj.interpretation ?? `Echo will apply this rule: ${raw}`,
  }
}
