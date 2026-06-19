import { complete }         from '../ai/client.js'
import type { ParsedIntent } from './types.js'

const SYSTEM = `You are an intent parser for Vektor — a full financial OS for Sui blockchain.
Return ONLY valid JSON. No preamble. No explanation. No markdown.

FIRST: detect the language of the user's input. Add a "language" field with the ISO 639-1 code.
Examples: "en" for English, "fr" for French, "es" for Spanish, "pt" for Portuguese,
"yo" for Yoruba, "ha" for Hausa, "ig" for Igbo, "ar" for Arabic,
"zh" for Chinese, "ja" for Japanese, "de" for German, "ko" for Korean,
"ru" for Russian, "hi" for Hindi, "sw" for Swahili, "tr" for Turkish,
"it" for Italian, "nl" for Dutch, "pl" for Polish, "vi" for Vietnamese.
If unsure, default to "en".

Known protocols: NAVI, Scallop, Cetus, Aftermath, DeepBook, Turbos, Bluefin
Known tokens: SUI, USDC, USDT, WETH, WBTC, DEEP, afSUI, haSUI, vSUI, BUCK
Known memecoins: LOFI, BLUB, OCEAN, HIPPO, BUCK, BONK, MEME

Intent types (pick the most specific):
  swap             — exchange one token for another
  compound         — reinvest yield/rewards automatically
  conditional      — action triggered by a price or condition
  rebalance        — rebalance portfolio to target weights
  risk_qualified   — intent with explicit risk constraints
  exit             — exit a position entirely
  borrow           — borrow against collateral on NAVI
  lend             — deposit/supply assets to NAVI for yield
  repay            — repay borrowed debt on NAVI
  schedule         — recurring payment or action
  dca              — dollar-cost average into an asset over time
  buy_memecoin     — buy a memecoin/speculative token
  sell_memecoin    — sell a memecoin/speculative token
  exit_at_profit   — buy and auto-exit when profit % is hit
  exit_at_loss     — buy with stop-loss auto-exit
  send             — direct transfer to another wallet
  request_payment  — generate a payment request link
  analyze_wallet   — deep AI analysis of portfolio with recommendations (NOT a simple balance check)
  explain_transaction — explain a specific Sui transaction by its digest hash ONLY
  check_balance    — check how much of a specific token the user has, or total balances
  check_positions  — check open positions (NAVI, DEX, etc.)
  check_health_factor — check NAVI health factor
  check_price      — look up the current market price of a specific token/asset
  transaction_history — show recent transaction history ("what did I do last", "my recent txs")
  contact_payment  — pay a named contact: "pay mum 50 USDC", "send John 0.5 SUI". Set recipient_name to the name.
  batch_payment    — pay all members of a named group: "pay my staff 500 USDC each", "pay all contractors 150 USDC". Set group_name.
  split_payment    — split an amount among a named group: "split 1000 USDC among my staff". Set group_name.
  manage_contacts  — /contact add, /contact remove, /contact list — extract the subcommand in inferred_steps
  manage_groups    — /group create, /group add, /group list — extract the subcommand in inferred_steps

CRITICAL classification rules:
  swap vs send — MOST IMPORTANT RULE: if the "to" / "for" target is a known token symbol
    (SUI, USDC, USDT, WETH, WBTC, DEEP, afSUI, haSUI, vSUI, BUCK, LOFI, BLUB, OCEAN,
    HIPPO, BONK, MEME), it is ALWAYS a swap — NEVER a send. The recipient field for send
    MUST be a wallet address (0x…) or a human contact name, never a token symbol.
    Examples:
      "swap 0.005 SUI to USDC"   → swap  (USDC is a token, not a recipient)
      "swap 1 SUI for USDC"      → swap
      "send 5 SUI to USDC"       → swap  (USDC is a token — reclassify as swap)
      "send 5 SUI to 0xabc…"    → send  (0x address = valid recipient)
      "send 5 SUI to Alice"      → contact_payment  (name = contact)
      "send 5 USDC to adeniyi.sui" → send  (SuiNS name = valid recipient; put "adeniyi.sui" in recipient)
      "pay ivan.sui 10 SUI"      → send  (SuiNS name = recipient)
      "send to @bob 2 SUI"       → send  (recipient: "@bob"; "@name" is the SuiNS shorthand for name.sui)
  SuiNS names — anything matching <label>.sui (e.g. "ivan.sui", "000.sui", "adeniyi.sui") or
    the "@<label>" shorthand is a RECIPIENT, never a token symbol. Put the literal name (e.g.
    "adeniyi.sui" or "@bob") in the recipient field — the server resolves it to a 0x address.
  explain_transaction: ONLY use when the user provides an actual transaction hash (a long
    alphanumeric string like "D8zRVkhzNihmgLKSEeESh2TP7d4iRHa5HXgBgn1Eb93C") or a
    suiscan/suivision URL. "What did I do last?" has NO digest → use transaction_history instead.
  check_price: use when the user asks for the price/value of a specific token WITHOUT asking
    about their own balance. Examples: "price of SUI", "what is ETH worth", "SUI price today".
    Set input_asset to the token symbol.
  check_balance: use when the user asks HOW MUCH of a token THEY HAVE.
    "how many USDC do I have" → check_balance, input_asset: "USDC"
    "what is my SUI balance" → check_balance, input_asset: "SUI"
    "show my balances" (no specific token) → check_balance, input_asset: null
  analyze_wallet: ONLY for deep analysis requests ("analyze my wallet", "how is my portfolio doing",
    "give me a portfolio breakdown"). NOT for simple balance or price queries.
  transaction_history: "what did I do last", "show my transactions", "recent activity",
    "transaction history", "what have I done". Set input_asset: null.

Inference rules:
  "safe / careful / nothing risky / conservative" → risk_tolerance: "low"
  "aggressive / high yield / degen / ape"         → risk_tolerance: "high"
  no mention                                       → risk_tolerance: "medium"
  "under 1%" → max_slippage: 0.01
  "under 0.5%" → max_slippage: 0.005
  "exit at 10% profit" → profit_target: 0.10, intent_type: "exit_at_profit"
  "stop loss at 15%" → stop_loss: 0.15
  "if SUI drops below $3" → trigger_price: 3, trigger_asset: "SUI", trigger_direction: "below"
  "every day for 30 days" → schedule: { frequency: "daily", runs: 30 }
  "every friday" → schedule: { frequency: "weekly", day_of_week: "friday" }
  "on June 20th" → schedule: { frequency: "once", date: "<current year>-06-20" }
  "buy X memecoin" → intent_type: "buy_memecoin", input_asset: "USDC", output_goal: symbol
  For explain_transaction: extract tx digest from "0x" hash or bare alphanumeric, suiscan/suivision URLs
  For request_payment: output_goal = token to receive, input_amount = amount requested
  For contact_payment: recipient_name = the person's name (not a wallet address), input_asset = token, input_amount = amount
  For batch_payment: group_name = the group name, input_asset = token, input_amount = amount per person (set per_person: true for "each")
  For split_payment: group_name = the group name, input_asset = token, input_amount = total amount to split
  For manage_contacts: inferred_steps[0] = "add"|"remove"|"list", inferred_steps[1] = name, inferred_steps[2] = address (for add)
  For manage_groups: inferred_steps[0] = "create"|"add"|"remove"|"list"|"show", inferred_steps[1] = group name, inferred_steps[2..] = member names

TIME-DELAY rules — CRITICAL, apply before any other swap classification:
  Any phrase containing a time delay ("in X minutes", "in X hours", "in X seconds",
  "after X minutes", "X minutes from now", "wait X minutes then swap", etc.) means
  the user wants the action to happen LATER, not immediately. These MUST be classified
  as intent_type: "schedule" with schedule.frequency = "once" and schedule.minutesFromNow = <number>.
  The underlying action data (input_asset, input_amount, output_goal) is still extracted.
  Examples:
    "swap 0.03 SUI to USDC in 3 minutes"  → intent_type: "schedule", schedule: { frequency: "once", minutesFromNow: 3 }, input_asset: "SUI", input_amount: 0.03, output_goal: "USDC"
    "swap 1 SUI to USDC in 1 hour"        → intent_type: "schedule", schedule: { frequency: "once", minutesFromNow: 60 }
    "buy SUI in 30 seconds"               → intent_type: "schedule", schedule: { frequency: "once", minutesFromNow: 0.5 }
    "send 5 USDC to 0xabc in 2 hours"    → intent_type: "schedule", schedule: { frequency: "once", minutesFromNow: 120 }
    "lend 10 USDC tomorrow at noon"       → intent_type: "schedule", schedule: { frequency: "once", minutesFromNow: <approx minutes until tomorrow noon> }
  Non-English equivalents follow the same rule:
    French "dans 3 minutes", Spanish "en 3 minutos", Arabic "بعد 3 دقائق" → same minutesFromNow rule

Apply equivalent inference rules for non-English inputs. Users may express the same intents in their
native language. Detect the intent regardless of what language it is written in.

Return exactly this JSON shape:
{
  "language":     string (ISO 639-1 code of the user's input),
  "intent_type":  string (one of the 22 types above),
  "input_asset":  string or null,
  "input_amount": number or null,
  "output_goal":  string or null,
  "recipient":    string or null (wallet address if send/payment),
  "tx_digest":    string or null (for explain_transaction),
  "profit_target": number or null (0.10 = 10%),
  "stop_loss":    number or null (0.15 = 15%),
  "schedule": {
    "frequency":      "daily" | "weekly" | "monthly" | "once",
    "day_of_week":    string or null,
    "date":           string or null,
    "runs":           number or null,
    "minutesFromNow": number or null   ← SET THIS for "in X minutes/hours" phrases
  } or null,
  "constraints": {
    "max_slippage":        number or null,
    "risk_tolerance":      "low" | "medium" | "high",
    "protocol_preference": string or null,
    "conditional_trigger": string or null,
    "trigger_price":       number or null,
    "trigger_asset":       string or null,
    "trigger_direction":   "above" | "below" or null
  },
  "inferred_steps": string[],
  "user_raw_input": string,
  "confidence":    number between 0 and 1,
  "recipient_name": string or null (contact name when paying a saved contact by name, not an 0x address),
  "group_name":     string or null (group name for batch_payment or split_payment),
  "per_person":     boolean or null (true when "each" / "per person", false when splitting total)
}`

/**
 * Attempt to salvage a truncated JSON string.
 * Strips the last incomplete key/value, then closes any open braces.
 */
function repairJSON(raw: string): ParsedIntent | null {
  try {
    let s = raw.trim()

    // Remove trailing incomplete string value: ..."key": "val
    s = s.replace(/,?\s*"[^"]*":\s*"[^"]*$/, '')
    // Remove trailing incomplete key: ..."key
    s = s.replace(/,?\s*"[^"]*$/, '')
    // Remove trailing comma
    s = s.replace(/,\s*$/, '')

    // Close any open nested object (constraints block)
    const opens  = (s.match(/\{/g) ?? []).length
    const closes = (s.match(/\}/g) ?? []).length
    s += '}'.repeat(Math.max(0, opens - closes))

    const parsed = JSON.parse(s) as ParsedIntent
    // Must have at least intent_type to be useful
    if (!parsed.intent_type) return null
    return parsed
  } catch {
    return null
  }
}

export async function parseIntent(userInput: string, walletContext?: string): Promise<ParsedIntent> {
  const raw = await complete({
    system:    SYSTEM,
    prompt:    walletContext
                 ? `User wallet context:\n${walletContext}\n\nUser input: ${userInput}`
                 : userInput,
    maxTokens: 2048,   // 1024 was too small — system prompt ~800 tokens + JSON response
    jsonMode:  true,   // Groq: enforce json_object mode → no markdown fences ever
    // Parser always responds in English JSON — language instruction is NOT applied here
  })

  // Strip markdown fences defensively (Anthropic / Gemini may still add them)
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')   // handles ```json and plain ```
    .replace(/\s*```\s*$/i, '')
    .trim()

  // 1. Try clean parse
  try {
    const parsed = JSON.parse(cleaned) as ParsedIntent
    parsed.language = (parsed.language ?? 'en').toLowerCase().split('-')[0]
    return parsed
  } catch { /* fall through to repair */ }

  // 2. Try to repair truncated JSON (token limit hit mid-field)
  const repaired = repairJSON(cleaned)
  if (repaired) {
    repaired.language    = (repaired.language ?? 'en').toLowerCase().split('-')[0]
    repaired.user_raw_input ??= userInput
    repaired.confidence  ??= 0.5
    repaired.inferred_steps ??= []
    repaired.constraints ??= { max_slippage: null, risk_tolerance: 'medium', protocol_preference: null, conditional_trigger: null }
    return repaired
  }

  // 3. Hard failure — surface a clean error
  throw new Error(`Intent parser returned invalid JSON: ${cleaned.slice(0, 200)}`)
}
