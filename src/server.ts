/**
 * Vektor API server — full financial OS for Sui.
 *
 * Unified /api/intent endpoint handles all 22 intent types.
 * Runs on port 3001. Vite proxies /api/* → http://localhost:3001/api/*
 *
 * Start: tsx src/server.ts
 */

import 'dotenv/config'

// Polyfill File global — required by Groq/OpenAI SDKs on Node < 20.
// Node 18 ships File inside node:buffer but doesn't expose it as a global.
import { File as NodeFile } from 'node:buffer'
if (!globalThis.File) { (globalThis as any).File = NodeFile }

import fs               from 'fs'
import path             from 'path'
import express          from 'express'
import cors             from 'cors'
import multer           from 'multer'
import Routex           from 'routex-sui'
import { complete, activeProvider, LANG_NAMES, SUPPORTED_LANGS } from './ai/client.js'
import {
  loadContacts, addContact, removeContact, listContacts, lookupContact,
  createGroup, addGroupMember, listGroups, lookupGroup, resolveGroupMembers,
  incrementPaymentCount,
} from './contacts/index.js'
import { walrusHealthCheck } from './walrus/client.js'

import { parseIntent }          from './parser/intent.js'
import { runGuardian }          from './guardian/v2.js'
import { rewritePTB }           from './guardian/rewriter.js'
import { fetchPortfolio, fetchRecentTxs, fetchTransaction, getTokenBalance } from './portfolio/fetcher.js'
import { getHealthFactor, getNaviPositions, getPoolRates,
         buildDepositPTB, buildBorrowPTB, buildRepayPTB } from './navi/client.js'
import { explainTransaction }   from './explainer/index.js'
import { createPaymentRequest, getPaymentStatus, fulfillPayment } from './payments/index.js'
import {
  addScheduled, getScheduled, cancelScheduled, getAllScheduled, getScheduledById,
  addCondition, getConditions, cancelCondition,
  getPositions, addPosition, cancelCondition as removeCondition,
  createInviteLink, getInviteLink, touchInviteLink,
} from './db/store.js'
import {
  getMemory, saveMemory, buildMemoryContext,
  getUnseenAlerts, markAlertsSeen, updatePortfolioSnapshot,
  addAlert, incrementIntentCount, logIntent,
  getPreferredLanguage, setPreferredLanguage,
} from './memory/index.js'
import { startScheduler }        from './scheduler/worker.js'
import { startConditionMonitor, getCurrentPrice, getAllPrices } from './conditions/monitor.js'
import { startAlertMonitor, registerWallet }     from './alerts/monitor.js'
import { readEchoData, writeEchoData }           from './echo/walrus.js'
import { calculateEchoScore, scoreInsights }     from './echo/score.js'
import { parseRule }                             from './echo/rules.js'
import { generateSessionKeypair, storeSessionKey, buildSessionAuthPtb, MODE_LIMITS } from './echo/session.js'

/* ─── VektorRegistry — local JSON counter ────────────────────────────────── */

const REGISTRY_FILE = path.resolve(process.cwd(), 'data/registry.json')

interface Registry { total_transactions: number; total_rewrites: number; last_updated: string }
function loadRegistry(): Registry {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) }
  catch { return { total_transactions: 0, total_rewrites: 0, last_updated: new Date().toISOString() } }
}
function saveRegistry(r: Registry): void {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true })
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ ...r, last_updated: new Date().toISOString() }, null, 2))
}
function bumpRegistry(field: 'total_transactions' | 'total_rewrites'): void {
  const r = loadRegistry(); r[field]++; saveRegistry(r)
}

const app    = express()
const PORT   = 3001

// Hard ceiling on the whole getQuote call.
// Worst-case: 5 s (direct, waiting for 7K) + 6 s hop cap, parallel = 6 s
// pathfinder + 2 s gas estimate = ~8 s. 18 s gives 10 s of headroom.
const QUOTE_MS = 18_000

function createRoutex(network: 'mainnet', sender: string) {
  return new Routex(network, sender)
}

// Serialize BigInt values as strings so res.json() never throws
app.set('json replacer', (_key: string, val: unknown) =>
  typeof val === 'bigint' ? val.toString() : val
)

const SIM_ADDR = '0x0000000000000000000000000000000000000000000000000000000000000001'

const TOKEN_DECIMALS: Record<string, number> = {
  SUI: 1e9, USDC: 1e6, USDT: 1e6, DEEP: 1e6, WETH: 1e8, WBTC: 1e8, BUCK: 1e9,
}

// Coin type addresses for batch payments
const TOKEN_COIN_TYPES: Record<string, string> = {
  SUI:  '0x2::sui::SUI',
  USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  USDT: '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
}

// Multer — memory storage for audio blobs (Whisper transcription)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

function toBaseUnits(amount: number, token: string): bigint {
  return BigInt(Math.round(amount * (TOKEN_DECIMALS[token.toUpperCase()] ?? 1e9)))
}

function serializeQuote(quote: any, from: string, to: string) {
  const inDec  = TOKEN_DECIMALS[from.toUpperCase()] ?? 1e9
  const outDec = TOKEN_DECIMALS[to.toUpperCase()]   ?? 1e9
  const amountOut = BigInt(quote.amountOut ?? 0)
  const amountIn  = BigInt(quote.amountIn  ?? 0)
  const gas       = BigInt(quote.gasEstimate ?? 0)
  const protocols = Array.from(new Map((quote.route ?? []).map((s: any) => [s.protocol, true])).keys())
  return {
    amountOut: amountOut.toString(),
    amountOutFormatted: (Number(amountOut) / outDec).toFixed(outDec >= 1e9 ? 4 : 6),
    amountIn:  amountIn.toString(),
    amountInFormatted: (Number(amountIn) / inDec).toFixed(inDec >= 1e9 ? 4 : 6),
    priceImpact: quote.priceImpact ?? 0,
    gasEstimate: gas.toString(),
    gasEstimateFormatted: (Number(gas) / 1e9).toFixed(4),
    validUntil:  quote.validUntil ?? Date.now() + 30_000,
    route: (quote.route ?? []).map((s: any) => ({ protocol: s.protocol })),
    routeLabel: protocols.join(' → '),
    hops: protocols.length,
    fromSymbol: from,
    toSymbol:   to,
    _raw: {
      amountIn: amountIn.toString(), amountOut: amountOut.toString(),
      priceImpact: quote.priceImpact ?? 0, gasEstimate: gas.toString(),
      slippageTolerance: quote.slippageTolerance ?? 0.005,
      validUntil: quote.validUntil,
      fromSymbol: from, toSymbol: to,
    },
  }
}

function serializeReport(r: any) {
  return { score: r.score, level: r.level, flags: r.flags, canProceed: r.canProceed, rewriteAvailable: r.rewriteAvailable }
}

/* ─── Parse next-run date for scheduler ─────────────────────────────────── */

function calcNextRun(spec: any): string {
  const now = new Date()
  if (!spec) return now.toISOString()

  // Time-delay: "in X minutes" / "in X hours"
  if (spec.minutesFromNow != null && spec.minutesFromNow > 0) {
    return new Date(now.getTime() + spec.minutesFromNow * 60_000).toISOString()
  }

  if (spec.date) return new Date(spec.date).toISOString()
  if (spec.frequency === 'once') return now.toISOString()
  if (spec.frequency === 'daily') {
    const next = new Date(now); next.setDate(now.getDate() + 1); next.setHours(12, 0, 0, 0)
    return next.toISOString()
  }
  if (spec.frequency === 'weekly') {
    const dayMap: Record<string, number> = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 }
    const target = dayMap[spec.day_of_week?.toLowerCase() ?? 'monday'] ?? 1
    const next   = new Date(now)
    const ahead  = (target + 7 - now.getDay()) % 7 || 7
    next.setDate(now.getDate() + ahead); next.setHours(12, 0, 0, 0)
    return next.toISOString()
  }
  return now.toISOString()
}

app.use(cors())
app.use(express.json())

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/intent  — unified intent handler
   Body: { text: string, senderAddress?: string }
   Returns unified response based on intent_type
───────────────────────────────────────────────────────────────────────── */

app.post('/api/intent', async (req, res) => {
  try {
    const { text, senderAddress } = req.body as { text: string; senderAddress?: string }
    const sender = senderAddress || SIM_ADDR
    if (!text?.trim()) { res.status(400).json({ ok: false, error: 'text is required' }); return }

    // ── Fast-path: /onboard command — skip LLM parsing ──────────────────────
    if (/^\/?onboard\b/i.test(text.trim())) {
      const BASE = process.env.VEKTOR_URL ?? 'http://localhost:5173'
      let inviteLink: string | null = null
      if (sender !== SIM_ADDR) {
        const invite = createInviteLink(sender)
        inviteLink   = `${BASE}?invite=${invite.token}`
      }
      const msg = [
        '**Welcome to Vektor** — your Financial OS for Sui.',
        '',
        'Here\'s what you can do:',
        '• **Swap** — "swap 10 USDC for SUI"',
        '• **Lend / borrow** — "deposit 5 SUI on NAVI" · "borrow 20 USDC"',
        '• **Automate** — "DCA $50 into SUI every week"',
        '• **Conditions** — "sell half my SUI if price drops below $2"',
        '• **Portfolio** — "check my balance" · "analyse my wallet"',
        '',
        inviteLink ? `Share Vektor with a friend: \`${inviteLink}\`` : 'Connect your wallet to get started.',
      ].join('\n')
      res.json({
        ok:          true,
        intent_type: 'onboard',
        language:    'en',
        inviteLink,
        message:     msg,
        actionLabel: '· ONBOARD',
      })
      return
    }

    // Load memory context for the user
    const memCtx  = sender !== SIM_ADDR ? buildMemoryContext(sender) : undefined
    const parsed  = await parseIntent(text, memCtx)

    // Guard: if the parser returned 'send' but the recipient is a known token symbol,
    // the LLM confused "swap X to TOKEN" with "send X to RECIPIENT". Reclassify as swap.
    const KNOWN_TOKEN_SYMBOLS = new Set([
      'SUI', 'USDC', 'USDT', 'WETH', 'WBTC', 'DEEP',
      'AFSUI', 'HASUI', 'VSUI', 'BUCK',
      'LOFI', 'BLUB', 'OCEAN', 'HIPPO', 'BONK', 'MEME',
    ])
    if (parsed.intent_type === 'send' && parsed.recipient &&
        KNOWN_TOKEN_SYMBOLS.has(parsed.recipient.toUpperCase())) {
      parsed.output_goal   ??= parsed.recipient
      parsed.recipient       = null
      parsed.intent_type     = 'swap'
    }

    let intent  = parsed.intent_type

    // ── Language detection ───────────────────────────────────────────────
    // Parser returns detected language. 'en' is NOT in SUPPORTED_LANGS (it's the default),
    // so we handle it explicitly to prevent stale non-English preferences from bleeding in.
    const rawLang = (parsed as any).language as string | undefined
    const lang = rawLang === 'en'               ? 'en'                                // parser says English → always English
               : (rawLang && SUPPORTED_LANGS.has(rawLang)) ? rawLang               // parser detected supported language
               : (sender !== SIM_ADDR ? getPreferredLanguage(sender) : 'en')       // fallback to stored preference

    // Register wallet for monitoring
    if (sender !== SIM_ADDR) {
      registerWallet(sender)
      incrementIntentCount(sender)
      logIntent(sender, { type: intent, summary: text.slice(0, 120), status: 'success' })
      // Persist language preference — always overwrite so stale non-English prefs get cleared
      setPreferredLanguage(sender, lang)
      // Bump registry on swap/memecoin types
      const swapTypes = ['swap', 'compound', 'rebalance', 'buy_memecoin', 'sell_memecoin', 'exit_at_profit', 'exit_at_loss']
      if (swapTypes.includes(intent)) bumpRegistry('total_transactions')
    }

    /* ── READ-ONLY intents ────────────────────────────────────────── */

    if (intent === 'check_balance') {
      const portfolio  = await fetchPortfolio(sender)
      if (sender !== SIM_ADDR) updatePortfolioSnapshot(sender, portfolio)
      const filterToken = parsed.input_asset?.toUpperCase() ?? null

      // If a specific token was asked about, highlight just that one
      if (filterToken) {
        const match = portfolio.balances.find(b => b.symbol.toUpperCase() === filterToken)
        const balStr = match ? `${match.formatted} ${match.symbol} (~$${match.usdValue?.toFixed(2) ?? '0.00'})` : `0 ${filterToken}`
        const msgEn  = `You have ${balStr}.`
        const message = lang === 'en' ? msgEn : await complete({
          system: 'You are Vektor. Translate this balance result exactly, keeping numbers and token symbols unchanged.',
          prompt: msgEn, maxTokens: 80, lang,
        }).catch(() => msgEn)
        res.json({
          ok: true, intent_type: intent, parsedIntent: parsed,
          portfolio, language: lang,
          message,
          actionLabel: `· BALANCE · ${balStr}`,
        })
        return
      }

      // No specific token — show full portfolio card
      const totalStr = `$${portfolio.totalUsd.toFixed(2)}`
      const assets   = portfolio.balances.slice(0, 5).map(b => `${b.symbol} ${b.formatted}`).join(', ')
      const message  = await complete({
        system: 'You are Vektor, a DeFi assistant on Sui. Give a concise 1-2 sentence balance summary.',
        prompt: `Total value: ${totalStr}. Holdings: ${assets || 'none'}.`,
        maxTokens: 150, lang,
      }).catch(() => `Total portfolio: ${totalStr}. Holdings: ${assets || 'none detected'}.`)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        portfolio, language: lang, message,
        actionLabel: `· BALANCE · ${totalStr}`,
      })
      return
    }

    if (intent === 'analyze_wallet') {
      const portfolio = await fetchPortfolio(sender)
      if (sender !== SIM_ADDR) updatePortfolioSnapshot(sender, portfolio)
      const totalStr  = `$${portfolio.totalUsd.toFixed(2)}`
      const assets    = portfolio.balances.map(b => `${b.symbol}: ${b.formatted} ($${b.usdValue?.toFixed(2)})`).join(', ')
      const naviInfo  = portfolio.navi
        ? `NAVI: supplied ${JSON.stringify(portfolio.navi.supplyBalances)}, borrowed ${JSON.stringify(portfolio.navi.borrowBalances)}, HF ${portfolio.navi.healthFactor?.toFixed(2)}`
        : 'No NAVI positions'

      const message = await complete({
        system: 'You are Vektor, a DeFi portfolio analyst on Sui. Analyze the user\'s portfolio and give 3-5 specific, actionable recommendations. Mention yield opportunities, risk factors, and diversification. Be concise but specific.',
        prompt: `Wallet: ${sender.slice(0, 8)}…\nTotal: ${totalStr}\nHoldings: ${assets || 'none'}\n${naviInfo}`,
        maxTokens: 400, lang,
      }).catch(() => `Portfolio value: ${totalStr}. ${assets || 'No tokens detected'}.`)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        portfolio, language: lang, message,
        actionLabel: `· ANALYSIS · ${totalStr}`,
      })
      return
    }

    if (intent === 'check_price') {
      const token  = (parsed.input_asset ?? '').toUpperCase()
      if (!token) {
        res.json({ ok: false, error: 'Which token price would you like to check?', language: lang })
        return
      }
      const prices = getAllPrices()
      const price  = prices[token]
      const msgEn  = price != null
        ? `${token} is currently trading at $${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD.`
        : `Price for ${token} is not available in the live feed. Try SUI, USDC, USDT, WETH, or WBTC.`
      const message = lang === 'en' ? msgEn : await complete({
        system: 'You are Vektor. Translate this price result exactly, keeping numbers and token symbols unchanged.',
        prompt: msgEn, maxTokens: 80, lang,
      }).catch(() => msgEn)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        price, token, language: lang, message,
        actionLabel: `· PRICE · ${token}${price != null ? ` · $${price.toFixed(4)}` : ' · N/A'}`,
      })
      return
    }

    if (intent === 'transaction_history') {
      const txs = await fetchRecentTxs(sender)
      if (txs.length === 0) {
        const msgEn = 'No recent transactions found for this wallet.'
        const message = lang === 'en' ? msgEn : await complete({
          system: 'You are Vektor. Translate this message exactly.',
          prompt: msgEn, maxTokens: 60, lang,
        }).catch(() => msgEn)
        res.json({ ok: true, intent_type: intent, parsedIntent: parsed, txs: [], language: lang, message, actionLabel: '· HISTORY · NONE' })
        return
      }
      const txSummary = txs.slice(0, 8).map((t: any, i: number) =>
        `${i + 1}. ${t.kind ?? 'tx'} — ${t.status} — ${new Date(t.timestamp).toLocaleString()}`
      ).join('\n')
      const msgEn   = `Here are your ${Math.min(txs.length, 8)} most recent transactions:\n${txSummary}`
      const message = lang === 'en' ? msgEn : await complete({
        system: 'You are Vektor. Translate this transaction history summary, keeping dates and status labels unchanged.',
        prompt: msgEn, maxTokens: 300, lang,
      }).catch(() => msgEn)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        txs, language: lang, message,
        actionLabel: `· HISTORY · ${txs.length} TXS`,
      })
      return
    }

    if (intent === 'check_health_factor') {
      const hf    = await getHealthFactor(sender)
      const level = hf === null ? 'unknown' : hf > 2 ? 'safe' : hf > 1.5 ? 'moderate' : hf > 1.3 ? 'warning' : 'danger'
      const hfMsg = hf === null
        ? 'No active NAVI borrow positions found, or could not fetch health factor.'
        : `Your NAVI health factor is ${hf.toFixed(2)} (${level}). Liquidation threshold is 1.0.`
      const message = lang === 'en' ? hfMsg : await complete({
        system: 'You are Vektor, a DeFi assistant. Translate the following message exactly.',
        prompt: hfMsg, maxTokens: 150, lang,
      }).catch(() => hfMsg)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        healthFactor: hf, language: lang,
        message,
        actionLabel: `· HEALTH FACTOR · ${hf?.toFixed(2) ?? 'N/A'}`,
      })
      return
    }

    if (intent === 'check_positions') {
      const [naviPos, positions] = await Promise.allSettled([
        getNaviPositions(sender),
        Promise.resolve(getPositions(sender)),
      ])
      const navi  = naviPos.status  === 'fulfilled' ? naviPos.value  : []
      const memes = positions.status === 'fulfilled' ? positions.value : []
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        naviPositions: navi, memePositions: memes, language: lang,
        message: [
          navi.length  ? `NAVI: ${navi.map(p => `${p.supplyBalance.toFixed(2)} ${p.symbol} supplied`).join(', ')}` : '',
          memes.length ? `Open positions: ${memes.map(p => p.token).join(', ')}` : '',
          !navi.length && !memes.length ? 'No open positions found.' : '',
        ].filter(Boolean).join(' '),
        actionLabel: `· POSITIONS · ${navi.length + memes.length} OPEN`,
      })
      return
    }

    if (intent === 'explain_transaction') {
      const input  = parsed.tx_digest ?? text
      const result = await explainTransaction(input, lang)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        explanation: result, language: lang,
        message:     result.explanation,
        actionLabel: `· EXPLAIN · TX ${result.digest.slice(0, 8)}…`,
      })
      return
    }

    /* ── Payment request ──────────────────────────────────────────── */

    if (intent === 'request_payment') {
      const token  = (parsed.output_goal ?? 'USDC').toUpperCase()
      const amount = parsed.input_amount ?? 0
      const link   = createPaymentRequest(sender, token, amount, text)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        payment:     link.payment,
        paymentLink: link.link,
        message:     `Payment request created: ${amount} ${token}. Share this link: ${link.link}`,
        actionLabel: `· PAYMENT REQUEST · ${amount} ${token}`,
      })
      return
    }

    /* ── Send (direct transfer) ───────────────────────────────────── */

    if (intent === 'send') {
      const token     = (parsed.input_asset ?? 'SUI').toUpperCase()
      const amount    = parsed.input_amount ?? 0
      const recipient = parsed.recipient ?? ''
      const sendMsgEn = `Ready to send ${amount} ${token} to ${recipient.slice(0, 8)}…${recipient.slice(-4)}. Confirm to proceed.`
      const sendMsg   = lang === 'en' ? sendMsgEn : await complete({
        system: 'You are Vektor. Translate this transfer confirmation exactly, keeping the address fragment unchanged.', prompt: sendMsgEn, maxTokens: 100, lang,
      }).catch(() => sendMsgEn)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        language: lang,
        message:     sendMsg,
        actionLabel: `· SEND · ${amount} ${token}`,
        ptbType:     'send',
        ptbParams:   { token, amount, recipient },
      })
      return
    }

    /* ── Contact payment — resolve name → address, then treat as send ── */

    if (intent === 'contact_payment') {
      const token         = (parsed.input_asset ?? 'SUI').toUpperCase()
      const amount        = parsed.input_amount ?? 0
      const recipientName = (parsed as any).recipient_name as string | null ?? parsed.recipient ?? ''

      if (!recipientName) {
        res.json({ ok: false, error: 'Who would you like to pay? Include their name.', language: lang })
        return
      }

      const resolvedAddress = sender !== SIM_ADDR
        ? await lookupContact(sender, recipientName).catch(() => null)
        : null

      if (!resolvedAddress) {
        const askEn = `I don't have an address saved for "${recipientName}". What's their wallet address?`
        const askMsg = lang === 'en' ? askEn : await complete({
          system: 'You are Vektor. Translate this question exactly, keeping the name unchanged.',
          prompt: askEn, maxTokens: 80, lang,
        }).catch(() => askEn)
        res.json({ ok: true, intent_type: 'general', parsedIntent: parsed, language: lang, message: askMsg, actionLabel: '· CONTACT · NOT FOUND' })
        return
      }

      const msgEn = `Ready to send ${amount} ${token} to ${recipientName} (${resolvedAddress.slice(0, 8)}…${resolvedAddress.slice(-4)}).`
      const msg   = lang === 'en' ? msgEn : await complete({
        system: 'You are Vektor. Translate this transfer confirmation exactly.',
        prompt: msgEn, maxTokens: 100, lang,
      }).catch(() => msgEn)

      res.json({
        ok: true, intent_type: 'send', parsedIntent: { ...parsed, recipient: resolvedAddress },
        language: lang, message: msg,
        actionLabel: `· PAY · ${recipientName} · ${amount} ${token}`,
        ptbType:    'send',
        ptbParams:  { token, amount, recipient: resolvedAddress, contactName: recipientName },
      })
      return
    }

    /* ── Manage contacts (/contact add / remove / list) ──────────── */

    if (intent === 'manage_contacts') {
      const steps  = parsed.inferred_steps ?? []
      const sub    = (steps[0] ?? '').toLowerCase()

      if (sub === 'list') {
        const contacts = sender !== SIM_ADDR ? await listContacts(sender).catch(() => []) : []
        const listMsgEn = contacts.length === 0
          ? 'You have no saved contacts yet. Add one with: /contact add 0xAddress as "Name"'
          : `Your contacts:\n${contacts.map(c => `• ${c.name} — ${c.address.slice(0, 10)}…`).join('\n')}`
        const listMsg = lang === 'en' ? listMsgEn : await complete({
          system: 'You are Vektor. Translate this contacts list exactly, preserving names and addresses.',
          prompt: listMsgEn, maxTokens: 200, lang,
        }).catch(() => listMsgEn)
        res.json({ ok: true, intent_type: intent, parsedIntent: parsed, language: lang, message: listMsg, contacts, actionLabel: `· CONTACTS · ${contacts.length} saved` })
        return
      }

      if (sub === 'add') {
        const name    = steps[1] ?? (parsed as any).recipient_name ?? ''
        const address = steps[2] ?? parsed.recipient ?? ''
        const note    = steps[3] ?? ''
        if (!name || !address) {
          res.json({ ok: false, error: 'Usage: /contact add 0xAddress as "Name"', language: lang }); return
        }
        const contact = sender !== SIM_ADDR
          ? await addContact(sender, name, address, note || undefined).catch(e => { throw e })
          : { name, address }
        const addMsgEn = `Saved ${name} (${address.slice(0, 10)}…) to your contacts on Walrus.`
        const addMsg   = lang === 'en' ? addMsgEn : await complete({
          system: 'You are Vektor. Translate this confirmation exactly.',
          prompt: addMsgEn, maxTokens: 80, lang,
        }).catch(() => addMsgEn)
        res.json({ ok: true, intent_type: intent, parsedIntent: parsed, language: lang, message: addMsg, contact, actionLabel: `· CONTACT SAVED · ${name}` })
        return
      }

      if (sub === 'remove') {
        const name = steps[1] ?? ''
        if (!name) { res.json({ ok: false, error: 'Which contact name to remove?', language: lang }); return }
        const removed = sender !== SIM_ADDR ? await removeContact(sender, name).catch(() => false) : false
        const delMsgEn = removed ? `Removed "${name}" from your contacts.` : `No contact named "${name}" found.`
        const delMsg   = lang === 'en' ? delMsgEn : await complete({
          system: 'You are Vektor. Translate this message exactly.',
          prompt: delMsgEn, maxTokens: 80, lang,
        }).catch(() => delMsgEn)
        res.json({ ok: true, intent_type: intent, parsedIntent: parsed, language: lang, message: delMsg, actionLabel: removed ? `· CONTACT REMOVED · ${name}` : '· NOT FOUND' })
        return
      }

      // Unknown sub-command — return usage
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed, language: lang,
        message: 'Contact commands:\n• /contact add 0xAddress as "Name"\n• /contact remove "Name"\n• /contact list',
        actionLabel: '· CONTACTS',
      })
      return
    }

    /* ── Manage groups (/group create / add / list / show) ───────── */

    if (intent === 'manage_groups') {
      const steps = parsed.inferred_steps ?? []
      const sub   = (steps[0] ?? '').toLowerCase()

      if (sub === 'list') {
        const groups = sender !== SIM_ADDR ? await listGroups(sender).catch(() => []) : []
        const listEn = groups.length === 0
          ? 'No groups yet. Create one with: /group create "Staff" with Alice, Bob, Carol'
          : `Your groups:\n${groups.map(g => `• ${g.name} (${g.members.length} members)`).join('\n')}`
        const listMsg = lang === 'en' ? listEn : await complete({
          system: 'You are Vektor. Translate this group list exactly.',
          prompt: listEn, maxTokens: 200, lang,
        }).catch(() => listEn)
        res.json({ ok: true, intent_type: intent, parsedIntent: parsed, language: lang, message: listMsg, groups, actionLabel: `· GROUPS · ${groups.length}` })
        return
      }

      if (sub === 'create') {
        const groupName = steps[1] ?? ''
        if (!groupName) { res.json({ ok: false, error: 'Group name required. Usage: /group create "Staff" with Alice, Bob', language: lang }); return }

        // Resolve member names from contacts for this user
        const memberNames = steps.slice(2)
        const contactList = sender !== SIM_ADDR ? await listContacts(sender).catch(() => []) : []
        const members = memberNames.map(name => {
          const c = contactList.find(ct => ct.name.toLowerCase() === name.toLowerCase())
          return { name, address: c?.address ?? '' }
        }).filter(m => m.address !== '')

        const group = sender !== SIM_ADDR
          ? await createGroup(sender, groupName, members).catch(e => { throw e })
          : { name: groupName, members, createdAt: Date.now() }

        const createEn = `Group "${groupName}" created with ${members.length} members: ${members.map(m => m.name).join(', ')}.`
        const createMsg = lang === 'en' ? createEn : await complete({
          system: 'You are Vektor. Translate this message exactly.',
          prompt: createEn, maxTokens: 120, lang,
        }).catch(() => createEn)
        res.json({ ok: true, intent_type: intent, parsedIntent: parsed, language: lang, message: createMsg, group, actionLabel: `· GROUP CREATED · ${groupName}` })
        return
      }

      if (sub === 'show') {
        const groupName = steps[1] ?? ''
        const group = sender !== SIM_ADDR ? await lookupGroup(sender, groupName).catch(() => null) : null
        const showEn = group
          ? `Group "${group.name}":\n${group.members.map(m => `• ${m.name} — ${m.address.slice(0, 10)}…`).join('\n')}`
          : `No group named "${groupName}" found.`
        const showMsg = lang === 'en' ? showEn : await complete({
          system: 'You are Vektor. Translate this message exactly.',
          prompt: showEn, maxTokens: 200, lang,
        }).catch(() => showEn)
        res.json({ ok: true, intent_type: intent, parsedIntent: parsed, language: lang, message: showMsg, group, actionLabel: group ? `· GROUP · ${groupName}` : '· NOT FOUND' })
        return
      }

      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed, language: lang,
        message: 'Group commands:\n• /group create "Name" with Alice, Bob\n• /group show "Name"\n• /group list',
        actionLabel: '· GROUPS',
      })
      return
    }

    /* ── Batch payment — "pay my staff 500 USDC each" ────────────── */

    if (intent === 'batch_payment' || intent === 'split_payment') {
      const token     = (parsed.input_asset ?? 'USDC').toUpperCase()
      const amount    = parsed.input_amount ?? 0
      const groupName = (parsed as any).group_name as string | null ?? ''
      const isSplit   = intent === 'split_payment' || (parsed as any).per_person === false
      const perPerson = !isSplit

      if (!groupName) {
        res.json({ ok: false, error: 'Which group should receive this payment? (e.g. "my staff")', language: lang }); return
      }

      const members = sender !== SIM_ADDR
        ? await resolveGroupMembers(sender, groupName).catch(() => null)
        : null

      if (!members || members.length === 0) {
        const notFoundEn = `I don't have a group called "${groupName}". Create one with: /group create "${groupName}" with Alice, Bob`
        const notFoundMsg = lang === 'en' ? notFoundEn : await complete({
          system: 'You are Vektor. Translate this message exactly.',
          prompt: notFoundEn, maxTokens: 100, lang,
        }).catch(() => notFoundEn)
        res.json({ ok: true, intent_type: 'general', parsedIntent: parsed, language: lang, message: notFoundMsg, actionLabel: '· GROUP · NOT FOUND' })
        return
      }

      const perPersonAmount = isSplit ? amount / members.length : amount
      const totalAmount     = isSplit ? amount : amount * members.length

      res.json({
        ok:          true,
        intent_type: intent,
        parsedIntent: parsed,
        language:    lang,
        message:     `Batch payment ready: ${members.length} recipients, ${perPersonAmount.toFixed(2)} ${token} each. Total: ${totalAmount.toFixed(2)} ${token}.`,
        actionLabel: `· BATCH · ${members.length} × ${perPersonAmount.toFixed(2)} ${token}`,
        batchData: {
          groupName,
          members,
          token,
          amountPerPerson: perPersonAmount,
          totalAmount,
          isSplit,
          perPerson,
        },
      })
      return
    }

    /* ── NAVI: lend / borrow / repay ──────────────────────────────── */

    if (intent === 'lend') {
      const token   = (parsed.input_asset ?? 'USDC').toUpperCase()
      const amount  = parsed.input_amount ?? 0
      const rates   = await getPoolRates(token).catch(() => null)
      const supplyApy = rates ? `${(Number((rates as any).base_supply_rate ?? 0) * 100).toFixed(2)}% APY` : ''

      let ptbB64: string | null = null
      try { ptbB64 = await buildDepositPTB(sender, token, amount) } catch { /* skip if wallet not available */ }

      const lendMsgEn  = `Lending ${amount} ${token} on NAVI.${supplyApy ? ` Current supply APY: ${supplyApy}.` : ''} Guardian will run before execution.`
      const lendMsg    = lang === 'en' ? lendMsgEn : await complete({
        system: 'You are Vektor. Translate this DeFi lending confirmation exactly.', prompt: lendMsgEn, maxTokens: 120, lang,
      }).catch(() => lendMsgEn)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        poolRates: rates, ptbB64, language: lang,
        message:     lendMsg,
        actionLabel: `· LEND · ${amount} ${token} → NAVI${supplyApy ? ` · ${supplyApy}` : ''}`,
      })
      return
    }

    if (intent === 'borrow') {
      const token   = (parsed.input_asset ?? parsed.output_goal ?? 'USDC').toUpperCase()
      const amount  = parsed.input_amount ?? 0
      const hf      = await getHealthFactor(sender)
      const safeToBorrow = hf === null || hf > 1.5

      let ptbB64: string | null = null
      try { ptbB64 = await buildBorrowPTB(sender, token, amount) } catch { /* skip */ }

      const borrowMsgEn = safeToBorrow
        ? `Borrowing ${amount} ${token} from NAVI. Current health factor: ${hf?.toFixed(2) ?? 'n/a'}. Guardian will run before execution.`
        : `⚠️ Health factor ${hf?.toFixed(2)} is too low to safely borrow. Repay existing debt first.`
      const borrowMsg = lang === 'en' ? borrowMsgEn : await complete({
        system: 'You are Vektor. Translate this DeFi borrow status message exactly.', prompt: borrowMsgEn, maxTokens: 120, lang,
      }).catch(() => borrowMsgEn)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        healthFactor: hf, safeToBorrow, ptbB64, language: lang,
        message:     borrowMsg,
        actionLabel: `· BORROW · ${amount} ${token} · HEALTH ${hf?.toFixed(2) ?? '?'}`,
      })
      return
    }

    if (intent === 'repay') {
      const token  = (parsed.input_asset ?? parsed.output_goal ?? 'USDC').toUpperCase()
      const amount = parsed.input_amount ?? 0

      let ptbB64: string | null = null
      try { ptbB64 = await buildRepayPTB(sender, token, amount) } catch { /* skip */ }

      const repayMsgEn = `Repaying ${amount} ${token} on NAVI. Guardian will run before execution.`
      const repayMsg   = lang === 'en' ? repayMsgEn : await complete({
        system: 'You are Vektor. Translate this DeFi repay message exactly.', prompt: repayMsgEn, maxTokens: 100, lang,
      }).catch(() => repayMsgEn)
      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        ptbB64, language: lang,
        message:     repayMsg,
        actionLabel: `· REPAY · ${amount} ${token} → NAVI`,
      })
      return
    }

    /* ── Schedule / DCA ───────────────────────────────────────────── */

    if (intent === 'schedule' || intent === 'dca') {
      const token       = (parsed.input_asset ?? '').toUpperCase()
      const targetToken = (parsed.output_goal ?? '').toUpperCase()
      const amount      = parsed.input_amount ?? 0
      const spec        = parsed.schedule
      const isDca       = intent === 'dca'

      // Guard: reject ghost records from informational queries ("what is DCA?")
      if (!amount || amount <= 0 || !token) {
        const mem = sender !== SIM_ADDR ? buildMemoryContext(sender) : ''
        const msg = (await complete({
          system: `You are Vektor, a DeFi financial OS for Sui. Be concise and helpful. ${mem}`,
          prompt: text, maxTokens: 300, lang,
        })).trim() || 'How can I help?'
        res.json({ ok: true, intent_type: 'general', parsedIntent: parsed, language: lang, message: msg, actionLabel: '· VEKTOR' })
        return
      }

      const nextRun   = calcNextRun(spec)
      const totalRuns = spec?.runs ?? (isDca ? 30 : 1)

      const record = addScheduled({
        wallet:      sender,
        type:        isDca ? 'dca' : (spec?.frequency === 'once' ? 'one-time' : 'payment'),
        intent:      parsed,
        amount,
        token,
        targetToken: targetToken || undefined,   // store for all swap types, not just DCA
        recipient:   parsed.recipient ?? undefined,
        schedule: {
          frequency:    spec?.frequency ?? 'daily',
          dayOfWeek:    spec?.day_of_week,
          date:         spec?.date,
          totalRuns,
          completedRuns: 0,
          nextRun,
        },
        active: true,
      })

      const freqLabel = spec?.frequency === 'weekly'
        ? `EVERY ${(spec.day_of_week ?? 'WEEK').toUpperCase()}`
        : spec?.frequency === 'once' ? 'ONE-TIME'
        : `EVERY ${(spec?.frequency ?? 'DAY').toUpperCase()}`

      const scheduleMsgEn = isDca
        ? `DCA set up: ${amount} ${token} → ${targetToken} ${freqLabel.toLowerCase()}${totalRuns > 1 ? ` for ${totalRuns} runs` : ''}. First run: ${new Date(nextRun).toLocaleDateString()}.`
        : `Payment scheduled: ${amount} ${token}${parsed.recipient ? ` to ${parsed.recipient.slice(0, 8)}…` : ''} ${freqLabel.toLowerCase()}. Next: ${new Date(nextRun).toLocaleDateString()}.`
      const scheduleMessage = lang === 'en' ? scheduleMsgEn : await complete({
        system: 'You are Vektor. Translate this DeFi scheduling confirmation exactly, keeping token symbols and dates unchanged.',
        prompt: scheduleMsgEn, maxTokens: 150, lang,
      }).catch(() => scheduleMsgEn)

      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        scheduled: record, language: lang,
        message:     scheduleMessage,
        actionLabel: `· ${isDca ? 'DCA' : 'SCHEDULED'} · ${amount} ${token}${targetToken ? ` → ${targetToken}` : ''} · ${freqLabel}`,
      })
      return
    }

    /* ── Conditional execution ────────────────────────────────────── */

    if (intent === 'conditional') {
      const { trigger_price, trigger_asset, trigger_direction } = parsed.constraints
      const assetSym  = (trigger_asset ?? 'SUI').toUpperCase()
      const threshold = trigger_price ?? 0
      const dir       = trigger_direction ?? 'below'
      const currentPx = getCurrentPrice(assetSym)

      const record = addCondition({
        wallet:      sender,
        description: text,
        trigger: {
          type:      dir === 'below' ? 'price_below' : 'price_above',
          asset:     assetSym,
          threshold,
        },
        action:      parsed,
        autoExecute: false,
      })

      const condMsgEn   = `Condition armed: will trigger when ${assetSym} goes ${dir} $${threshold}. Current price: $${currentPx?.toFixed(4) ?? '?'}. Polling every 30s.`
      const condMessage = lang === 'en' ? condMsgEn : await complete({
        system: 'You are Vektor. Translate this DeFi condition alert exactly, keeping token symbols, prices, and technical terms.',
        prompt: condMsgEn, maxTokens: 150, lang,
      }).catch(() => condMsgEn)

      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        condition: record, language: lang,
        currentPrice: currentPx,
        message:      condMessage,
        actionLabel:  `· WATCH · ${assetSym} ${dir === 'below' ? '<' : '>'} $${threshold} · ARMED`,
      })
      return
    }

    /* ── Memecoin: buy / sell / exit_at_profit / exit_at_loss ─────── */

    if (intent === 'buy_memecoin' || intent === 'exit_at_profit' || intent === 'exit_at_loss') {
      const fromToken  = (parsed.input_asset ?? 'USDC').toUpperCase()
      const memeToken  = (parsed.output_goal ?? 'LOFI').toUpperCase()
      const amount     = parsed.input_amount ?? 0
      const amountIn   = toBaseUnits(amount, fromToken)

      const routex  = createRoutex('mainnet', sender)
      const quote   = await Promise.race([
        routex.getQuote({
          from:              fromToken,
          to:                memeToken,
          amount:            amountIn,
          slippageTolerance: parsed.constraints.max_slippage ?? 0.02,
          senderAddress:     sender,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Quote timed out — try again in a moment.')), QUOTE_MS)
        ),
      ]).catch(() => ({ amountOut: 0n, amountIn, priceImpact: 0.05, route: [], gasEstimate: 0n, validUntil: Date.now() + 30_000 }))

      const quoteWithSym = { ...quote, fromSymbol: fromToken, toSymbol: memeToken }
      const report       = await runGuardian(quoteWithSym, sender, null, lang)

      // Track position if auto-exit
      if (parsed.profit_target || parsed.stop_loss) {
        addPosition({
          wallet:         sender,
          token:          memeToken,
          entryAmountUsd: amount,
          entryPrice:     0, // fetched at execution
          profitTarget:   parsed.profit_target ?? undefined,
          stopLoss:       parsed.stop_loss ?? undefined,
          autoExit:       true,
        })
      }

      const label = parsed.profit_target
        ? `· BUY ${memeToken} · TARGET +${(parsed.profit_target * 100).toFixed(0)}% · SCORE ${report.score}/100`
        : parsed.stop_loss
        ? `· BUY ${memeToken} · STOP -${(parsed.stop_loss * 100).toFixed(0)}% · SCORE ${report.score}/100`
        : `· MEMECOIN · ${fromToken} → ${memeToken} · SCORE ${report.score}/100`

      const memeIssues  = report.flags.filter(f => f.severity !== 'green').map(f => f.title).join(', ') || 'all clear'
      const memeMsgEn   = `Routing ${amount} ${fromToken} into ${memeToken}. Guardian flagged: ${memeIssues}.`
      const memeMessage = lang === 'en' ? memeMsgEn : await complete({
        system: 'You are Vektor. Translate this DeFi routing status message exactly, keeping token symbols in English.',
        prompt: memeMsgEn, maxTokens: 150, lang,
      }).catch(() => memeMsgEn)

      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        quote:    serializeQuote(quoteWithSym, fromToken, memeToken),
        report:   serializeReport(report),
        _rawReport: report,
        quoteParams: { from: fromToken, to: memeToken, amountIn: toBaseUnits(amount, fromToken).toString(), slippage: parsed.constraints.max_slippage ?? 0.005, sender },
        language: lang,
        message:  memeMessage,
        actionLabel: label,
      })
      return
    }

    if (intent === 'sell_memecoin' || intent === 'exit') {
      const memeToken = (parsed.input_asset ?? parsed.output_goal ?? 'LOFI').toUpperCase()
      const toToken   = 'USDC'
      const amount    = parsed.input_amount ?? 0

      res.json({
        ok: true, intent_type: intent, parsedIntent: parsed,
        message:     `Exiting ${memeToken} position${amount ? ` for ${amount} ${memeToken}` : ' (full position)'}. Routing to ${toToken} via Routex.`,
        actionLabel: `· EXIT · ${memeToken} → ${toToken}`,
        ptbType:     'exit',
        ptbParams:   { fromToken: memeToken, toToken, amount },
      })
      return
    }

    /* ── SWAP / COMPOUND / REBALANCE / RISK_QUALIFIED (Routex) ───── */

    const fromToken = (parsed.input_asset ?? 'SUI').toUpperCase()
    const toToken   = (parsed.output_goal ?? 'USDC').toUpperCase()

    if (!parsed.input_asset || !parsed.output_goal || !parsed.input_amount) {
      // Conversational fallback — respond naturally in user's language
      const mem = sender !== SIM_ADDR ? buildMemoryContext(sender) : ''
      const msg = (await complete({
        system:    `You are Vektor, a DeFi financial OS for Sui. Be concise and helpful. ${mem}`,
        prompt:    text,
        maxTokens: 300,
        lang,
      })).trim() || 'How can I help?'
      res.json({ ok: true, intent_type: 'general', parsedIntent: parsed, language: lang, message: msg, actionLabel: '· VEKTOR' })
      return
    }

    const amountIn = toBaseUnits(parsed.input_amount, fromToken)

    // ── Balance check — reject before hitting Routex ─────────────────
    if (sender !== SIM_ADDR) {
      const required = parsed.input_amount!
      const actual   = await getTokenBalance(sender, fromToken).catch(() => Infinity)
      if (actual < required) {
        const have    = actual.toFixed(TOKEN_DECIMALS[fromToken] >= 1e9 ? 4 : 6)
        const need    = required.toFixed(TOKEN_DECIMALS[fromToken] >= 1e9 ? 4 : 6)
        const errEn   = `Insufficient ${fromToken} balance. You have ${have} ${fromToken} but this swap needs ${need} ${fromToken}.`
        const errMsg  = lang === 'en' ? errEn : await complete({
          system: 'You are Vektor. Translate this error message exactly, keeping token symbols and numbers unchanged.',
          prompt: errEn, maxTokens: 80, lang,
        }).catch(() => errEn)
        res.json({ ok: false, error: errMsg, language: lang })
        return
      }
    }

    // SEAL_V1.5 — encrypt intent here using Seal SDK before submission
    // Prevents front-running by keeping intent private until execution moment
    // Do not implement now. Reserved for v1.5.

    const routex = createRoutex('mainnet', sender)
    const quote  = await Promise.race([
      routex.getQuote({
        from:              fromToken,
        to:                toToken,
        amount:            amountIn,
        slippageTolerance: parsed.constraints.max_slippage ?? 0.005,
        senderAddress:     sender,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Quote timed out — try again in a moment.')), QUOTE_MS)
      ),
    ])

    const quoteWithSym = { ...quote, fromSymbol: fromToken, toSymbol: toToken }
    const report       = await runGuardian(quoteWithSym, sender, null, lang)

    res.json({
      ok: true, intent_type: intent, parsedIntent: parsed,
      quote:    serializeQuote(quoteWithSym, fromToken, toToken),
      report:   serializeReport(report),
      _rawReport: report,
      language: lang,
      // Store params so client can request a fresh PTB at execution time
      quoteParams: {
        from:      fromToken,
        to:        toToken,
        amountIn:  amountIn.toString(),
        slippage:  parsed.constraints.max_slippage ?? 0.005,
        sender,
      },
      actionLabel: (() => {
        const protocols = (quote.route ?? []).map((s: any) => s.protocol.toUpperCase())
        const chain = protocols.length
          ? [fromToken, ...protocols, toToken].join(' → ')
          : `${fromToken} → ${toToken}`
        return `· SWAP · ${chain} · SCORE ${report.score}/100`
      })(),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── POST /api/guard (backward compat) ───────────────────────────────── */

app.post('/api/guard', async (req, res) => {
  req.body.text = req.body.text ?? req.body.input
  return app._router.handle(
    { ...req, url: '/api/intent', path: '/api/intent' } as any,
    res,
    () => {},
  )
})

/* ─── POST /api/rewrite ───────────────────────────────────────────────── */

app.post('/api/rewrite', async (req, res) => {
  try {
    const { rawReport, senderAddress } = req.body
    const sender = senderAddress || SIM_ADDR
    if (!rawReport) { res.status(400).json({ ok: false, error: 'rawReport is required' }); return }
    const rewritten = await rewritePTB(rawReport, sender, 'mainnet')
    const q    = rewritten.rewrittenQuote ?? rewritten.originalQuote
    const from = q.fromSymbol ?? rawReport.originalQuote?.fromSymbol ?? 'SUI'
    const to   = q.toSymbol   ?? rawReport.originalQuote?.toSymbol   ?? 'USDC'

    // Bump registry
    bumpRegistry('total_rewrites')

    const origScore    = rawReport.score ?? 0
    const rewriteScore = rewritten.score ?? 0
    const improved     = rewriteScore > origScore + 2  // require at least 3-point improvement

    // Build before/after diff for the UI
    const origQ = rawReport.originalQuote ?? {}
    const diff  = {
      before: {
        score:       origScore,
        amountOut:   origQ.amountOut   ?? '0',
        priceImpact: origQ.priceImpact ?? 0,
        route:       (origQ.route ?? []).map((s: any) => s.protocol),
      },
      after: {
        score:       rewriteScore,
        amountOut:   q.amountOut   ?? '0',
        priceImpact: q.priceImpact ?? 0,
        route:       (q.route ?? []).map((s: any) => s.protocol),
      },
    }

    // If rewrite produced no meaningful improvement, tell the user instead of
    // showing a misleading "BEFORE/AFTER" comparison with identical scores.
    if (!improved) {
      const reason = rewritten.flags
        .filter((f: any) => f.severity !== 'green')
        .map((f: any) => f.title)
        .join(', ') || 'route complexity'
      res.json({
        ok:       true,
        improved: false,
        message:  `This route is already optimal — ${from}→${to} only has one viable path on Sui. ` +
                  `The score of ${origScore}/100 reflects inherent risk from ${reason}, not a bad routing choice. ` +
                  `You can still proceed by acknowledging the risk below.`,
        diff,
      })
      return
    }

    res.json({
      ok:       true,
      improved: true,
      quote:    serializeQuote({ ...q, fromSymbol: from, toSymbol: to }, from, to),
      report:   serializeReport(rewritten),
      _rawReport: rewritten,
      diff,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/* ─── Guardian simulation ─────────────────────────────────────────────── */

app.post('/api/simulate', async (req, res) => {
  try {
    const { txDigest, senderAddress } = req.body
    const sender = senderAddress || SIM_ADDR

    if (txDigest) {
      // Simulate from an on-chain tx
      const tx    = await fetchTransaction(txDigest)
      const bc    = (tx as any).balanceChanges ?? []
      const inB   = bc.find((b: any) => Number(b.amount) < 0)
      const outB  = bc.find((b: any) => Number(b.amount) > 0)
      const fakeQuote = {
        amountIn:    Math.abs(Number(inB?.amount ?? 0)).toString(),
        amountOut:   Math.abs(Number(outB?.amount ?? 0)).toString(),
        priceImpact: 0.001,
        gasEstimate: '5000000',
        route:       [],
        fromSymbol:  'SUI',
        toSymbol:    'USDC',
      }
      const report = await runGuardian(fakeQuote, sender, null)
      res.json({ ok: true, report: serializeReport(report), language: 'en', actionLabel: `· SIMULATE · SCORE ${report.score}/100` })
      return
    }

    res.status(400).json({ ok: false, error: 'txDigest required for simulation' })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/* ─── Portfolio ───────────────────────────────────────────────────────── */

app.post('/api/portfolio', async (req, res) => {
  try {
    const { wallet } = req.body as { wallet: string }
    if (!wallet) { res.status(400).json({ ok: false, error: 'wallet required' }); return }
    registerWallet(wallet)
    const portfolio = await fetchPortfolio(wallet)
    updatePortfolioSnapshot(wallet, portfolio)

    // Deep analytics from recent tx history
    const successTxs = portfolio.recentTxs.filter(t => t.status === 'success')
    const analytics = {
      txCount:      portfolio.recentTxs.length,
      successCount: successTxs.length,
      failedCount:  portfolio.recentTxs.length - successTxs.length,
      // Gas: each tx costs ~0.003-0.01 SUI on average; we estimate from tx count
      estimatedGasSui:  (successTxs.length * 0.005).toFixed(4),
      // Top balances for quick summary
      topAssets: portfolio.balances.slice(0, 3).map(b => b.symbol),
    }

    res.json({ ok: true, portfolio, analytics })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/* ─── Scheduler CRUD ─────────────────────────────────────────────────── */

app.get('/api/schedule/:wallet', (req, res) => {
  res.json({ ok: true, scheduled: getScheduled(req.params.wallet) })
})

app.delete('/api/schedule/:id', (req, res) => {
  const ok = cancelScheduled(req.params.id)
  res.json({ ok })
})

/* ─── Conditions CRUD ────────────────────────────────────────────────── */

app.get('/api/conditions/:wallet', (req, res) => {
  res.json({ ok: true, conditions: getConditions(req.params.wallet) })
})

app.delete('/api/conditions/:id', (req, res) => {
  const ok = cancelCondition(req.params.id)
  res.json({ ok })
})

/* ─── Onboarding ─────────────────────────────────────────────────────── */

/** Create a shareable invite link for the calling wallet. */
app.post('/api/onboard/link', (req, res) => {
  const { creatorWallet } = req.body as { creatorWallet?: string }
  if (!creatorWallet) { res.status(400).json({ ok: false, error: 'creatorWallet required' }); return }
  const BASE   = process.env.VEKTOR_URL ?? 'http://localhost:5173'
  const invite = createInviteLink(creatorWallet)
  res.json({ ok: true, invite, link: `${BASE}?invite=${invite.token}` })
})

/** Resolve an invite token → creator info.  Called by WelcomePage on load. */
app.get('/api/onboard/:token', (req, res) => {
  const invite = touchInviteLink(req.params.token)
  if (!invite) { res.status(404).json({ ok: false, error: 'Invite not found or expired' }); return }
  res.json({ ok: true, invite: { creatorWallet: invite.creatorWallet, createdAt: invite.createdAt, uses: invite.uses } })
})

/* ─── Payments ───────────────────────────────────────────────────────── */

app.get('/api/payment/:id', (req, res) => {
  const payment = getPaymentStatus(req.params.id)
  if (!payment) { res.status(404).json({ ok: false, error: 'Payment not found' }); return }
  res.json({ ok: true, payment })
})

// Mark a payment as paid (called after the payer's tx is confirmed)
app.post('/api/payment/:id/pay', (req, res) => {
  const { paidBy } = req.body as { paidBy?: string }
  const payment    = getPaymentStatus(req.params.id)
  if (!payment) { res.status(404).json({ ok: false, error: 'Payment not found' }); return }
  if (payment.status === 'paid') { res.json({ ok: true, payment }); return }
  fulfillPayment(req.params.id, paidBy ?? 'unknown')
  res.json({ ok: true, payment: { ...payment, status: 'paid' } })
})

/* ─── NAVI PTB builder — builds deposit/borrow/repay tx for wallet signing ─── */

app.post('/api/navi-ptb', async (req, res) => {
  try {
    const { type, token, amount, sender } = req.body as { type: string; token: string; amount: number; sender: string }
    if (!type || !token || !amount || !sender) {
      res.status(400).json({ ok: false, error: 'Missing required fields: type, token, amount, sender' }); return
    }
    let ptbB64: string
    if (type === 'lend') {
      ptbB64 = await buildDepositPTB(sender, token, amount)
    } else if (type === 'borrow') {
      ptbB64 = await buildBorrowPTB(sender, token, amount)
    } else if (type === 'repay') {
      ptbB64 = await buildRepayPTB(sender, token, amount)
    } else {
      res.status(400).json({ ok: false, error: `Unknown NAVI operation type: ${type}` }); return
    }
    res.json({ ok: true, ptbB64 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── Execute a scheduled swap — builds Guardian-reviewed quote for signing ── */
// Called by the UI when the user clicks Execute on a scheduler alert.
// Looks up the schedule by ID, runs Routex + Guardian, returns a swap response
// identical to /api/intent so the existing ConfirmationGate flow handles signing.

app.post('/api/execute-scheduled/:id', async (req, res) => {
  try {
    const { senderAddress } = req.body as { senderAddress?: string }
    const sender = senderAddress || SIM_ADDR

    // Use getScheduledById — looks up by ID regardless of active status because
    // markScheduledRun() already deactivated it before the alert was created.
    const scheduled = getScheduledById(req.params.id)
    if (!scheduled) {
      res.status(404).json({ ok: false, error: 'Scheduled intent not found' }); return
    }

    const fromToken  = scheduled.token.toUpperCase()
    const toToken    = (scheduled.targetToken ?? scheduled.intent?.output_goal ?? 'USDC').toUpperCase()
    const amount     = scheduled.amount
    const lang       = sender !== SIM_ADDR ? getPreferredLanguage(sender) : 'en'

    // Balance check before hitting Routex
    if (sender !== SIM_ADDR) {
      const actual = await getTokenBalance(sender, fromToken).catch(() => Infinity)
      if (actual < amount) {
        const errEn = `Insufficient ${fromToken} balance for scheduled swap. You have ${actual.toFixed(4)} ${fromToken} but need ${amount} ${fromToken}.`
        const errMsg = lang === 'en' ? errEn : await complete({
          system: 'You are Vektor. Translate this error message exactly, keeping token symbols and numbers unchanged.',
          prompt: errEn, maxTokens: 80, lang,
        }).catch(() => errEn)
        res.json({ ok: false, error: errMsg, language: lang }); return
      }
    }

    const amountIn = toBaseUnits(amount, fromToken)
    const routex   = createRoutex('mainnet', sender)
    const quote    = await Promise.race([
      routex.getQuote({
        from:              fromToken,
        to:                toToken,
        amount:            amountIn,
        slippageTolerance: scheduled.intent?.constraints?.max_slippage ?? 0.005,
        senderAddress:     sender,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Quote timed out — try again in a moment.')), QUOTE_MS)
      ),
    ])

    const quoteWithSym = { ...quote, fromSymbol: fromToken, toSymbol: toToken }
    const report       = await runGuardian(quoteWithSym, sender, null, lang)

    // Return the same shape as /api/intent swap response so the UI can render
    // PTBPreview + GuardianReport + ConfirmationGate directly.
    res.json({
      ok:          true,
      intent_type: 'swap',
      parsedIntent: scheduled.intent ?? {
        input_asset: fromToken, output_goal: toToken, input_amount: amount,
        constraints: { max_slippage: 0.005, risk_tolerance: 'medium', protocol_preference: null, conditional_trigger: null },
      },
      quote:      serializeQuote(quoteWithSym, fromToken, toToken),
      report:     serializeReport(report),
      _rawReport: report,
      language:   lang,
      quoteParams: {
        from:     fromToken,
        to:       toToken,
        amountIn: amountIn.toString(),
        slippage: scheduled.intent?.constraints?.max_slippage ?? 0.005,
        sender,
      },
      actionLabel: `· SCHEDULED SWAP · ${fromToken} → ${toToken} · SCORE ${report.score}/100`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── PTB builder — returns serialized tx bytes for wallet signing ─── */

app.post('/api/ptb', async (req, res) => {
  try {
    const { from, to, amountIn, slippage, sender } = req.body
    if (!from || !to || !amountIn || !sender) {
      res.status(400).json({ ok: false, error: 'Missing required fields' }); return
    }
    const routex = createRoutex('mainnet', sender)
    const quote  = await Promise.race([
      routex.getQuote({
        from,
        to,
        amount:            BigInt(amountIn),
        slippageTolerance: slippage ?? 0.005,
        senderAddress:     sender,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Quote timed out — try again in a moment.')), QUOTE_MS)
      ),
    ])

    // Feature 5: VektorLog — atomically append on-chain log call when package is deployed
    const logPackageId = process.env.VEKTORLOG_PACKAGE_ID
    if (logPackageId) {
      try {
        const summary = `${from}→${to} ${amountIn}`
        quote.ptb.moveCall({
          target:    `${logPackageId}::log::record`,
          arguments: [quote.ptb.pure.string(summary.slice(0, 64))],
        })
      } catch { /* log append failed — still execute the swap */ }
    }

    const ptbJson = quote.ptb.serialize()
    res.json({ ok: true, ptbJson })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── VektorRegistry stats ────────────────────────────────────────────── */

app.get('/api/stats', (_, res) => {
  res.json({ ok: true, registry: loadRegistry() })
})

/* ─── Live prices (from Pyth cache) ──────────────────────────────────── */

app.get('/api/prices', (_, res) => {
  res.json({ ok: true, prices: getAllPrices() })
})

/* ─── Alerts ─────────────────────────────────────────────────────────── */

app.get('/api/alerts/:wallet', (req, res) => {
  const alerts = getUnseenAlerts(req.params.wallet)
  markAlertsSeen(req.params.wallet)
  res.json({ ok: true, alerts })
})

/* ─── Memory ─────────────────────────────────────────────────────────── */

app.get('/api/memory/:wallet', (req, res) => {
  const mem     = getMemory(req.params.wallet)
  const prices  = getAllPrices()
  const sched   = getScheduled(req.params.wallet)

  // Build DCA progress summary
  const dcaItems = sched.filter(s => s.type === 'dca' && s.active)
  const dcaSummary = dcaItems.map(d => ({
    token:    `${d.amount} ${d.token} → ${d.targetToken ?? '?'}`,
    progress: `${d.schedule.completedRuns}/${d.schedule.totalRuns} runs`,
    nextRun:  d.schedule.nextRun,
  }))

  // Build price context
  const priceContext = Object.entries(prices)
    .filter(([, p]) => p > 0)
    .slice(0, 5)
    .reduce((acc, [sym, price]) => ({ ...acc, [sym]: price }), {} as Record<string, number>)

  res.json({
    ok: true,
    memory: mem,
    dcaSummary,
    priceContext,
  })
})

/* ─── Contacts ────────────────────────────────────────────────────────── */

app.get('/api/contacts/:wallet', async (req, res) => {
  try {
    const contacts = await listContacts(req.params.wallet)
    const groups   = await listGroups(req.params.wallet)
    res.json({ ok: true, contacts, groups })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/contacts/:wallet', async (req, res) => {
  try {
    const { name, address, note } = req.body as { name: string; address: string; note?: string }
    if (!name || !address) { res.status(400).json({ ok: false, error: 'name and address required' }); return }
    const contact = await addContact(req.params.wallet, name, address, note)
    res.json({ ok: true, contact })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/contacts/:wallet/:name', async (req, res) => {
  try {
    const removed = await removeContact(req.params.wallet, decodeURIComponent(req.params.name))
    res.json({ ok: removed })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/* ─── Groups ──────────────────────────────────────────────────────────── */

app.post('/api/groups/:wallet', async (req, res) => {
  try {
    const { name, members } = req.body as { name: string; members: { name: string; address: string }[] }
    if (!name) { res.status(400).json({ ok: false, error: 'group name required' }); return }
    const group = await createGroup(req.params.wallet, name, members ?? [])
    res.json({ ok: true, group })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/groups/:wallet/:groupName/members', async (req, res) => {
  try {
    const { name, address } = req.body as { name: string; address: string }
    if (!name || !address) { res.status(400).json({ ok: false, error: 'name and address required' }); return }
    const ok = await addGroupMember(req.params.wallet, decodeURIComponent(req.params.groupName), { name, address })
    res.json({ ok })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/* ─── Batch payment PTB builder ───────────────────────────────────────── */

app.post('/api/batch-payment-ptb', async (req, res) => {
  try {
    const { senderAddress, members, amountPerPerson, token } = req.body as {
      senderAddress: string
      members:       { name: string; address: string }[]
      amountPerPerson: number
      token:           string
    }

    if (!senderAddress || !members?.length || !amountPerPerson || !token) {
      res.status(400).json({ ok: false, error: 'Missing required batch payment fields' }); return
    }

    const { Transaction } = await import('@mysten/sui/transactions')
    const tx = new Transaction()
    tx.setSender(senderAddress)

    const tokenUpper  = token.toUpperCase()
    const coinType    = TOKEN_COIN_TYPES[tokenUpper] ?? '0x2::sui::SUI'
    const decimals    = TOKEN_DECIMALS[tokenUpper]   ?? 1e9
    const amountMist  = BigInt(Math.round(amountPerPerson * decimals))

    if (tokenUpper === 'SUI') {
      // Use gas coin for SUI transfers — most gas-efficient
      const splits = tx.splitCoins(
        tx.gas,
        members.map(() => tx.pure.u64(amountMist)),
      )
      members.forEach((m, i) => tx.transferObjects([splits[i]], m.address))
    } else {
      // For other tokens: coinWithBalance per recipient
      // Transaction builder handles coin selection/merging automatically
      const { coinWithBalance } = await import('@mysten/sui/transactions')
      for (const member of members) {
        const coin = coinWithBalance({ type: coinType, balance: amountMist }) as any
        tx.transferObjects([coin], member.address)
      }
    }

    const ptbJson = tx.serialize()
    res.json({ ok: true, ptbJson, recipientCount: members.length, totalAmount: amountPerPerson * members.length, token })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── Walrus health check ─────────────────────────────────────────────── */

app.get('/api/walrus/health', async (_, res) => {
  const ok = await walrusHealthCheck()
  res.json({ ok, network: process.env.SUI_NETWORK ?? 'mainnet' })
})

/* ─── Voice transcription — POST /api/transcribe ─────────────────────── */
// Accepts audio blob (webm/mp4/wav), returns transcribed text via Whisper.
// Audio is NOT stored anywhere — transcribed and discarded immediately.
//
// NOTE: multer middleware is invoked manually inside the async handler so that
// upload errors (wrong content-type, size limit, parse failure) are caught and
// returned as JSON instead of falling through to Express's HTML error handler.

app.post('/api/transcribe', async (req, res) => {
  // ── Step 1: run multer, guarantee JSON error on failure ──────────────
  try {
    await new Promise<void>((resolve, reject) =>
      upload.single('audio')(req as any, res as any, (err: unknown) =>
        err ? reject(err) : resolve()
      )
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(400).json({ ok: false, error: `Upload error: ${msg}` })
    return
  }

  // ── Step 2: transcribe ────────────────────────────────────────────────
  try {
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'No audio file received. Make sure the field name is "audio".' })
      return
    }

    // Use Groq Whisper (already have GROQ_API_KEY), fall back to OpenAI if configured
    const groqKey  = process.env.GROQ_API_KEY
    const openaiKey = process.env.OPENAI_API_KEY
    if (!groqKey && !openaiKey) {
      res.status(503).json({ ok: false, error: 'No transcription API key configured (need GROQ_API_KEY or OPENAI_API_KEY in .env).' })
      return
    }

    const wallet   = (req.body as any).wallet   as string | undefined
    const langHint = (req.body as any).language as string | undefined
    const lang     = langHint || (wallet ? getPreferredLanguage(wallet) : undefined)

    const mimeType = req.file.mimetype || 'audio/webm'
    const ext      = mimeType.includes('mp4') ? 'm4a'
                   : mimeType.includes('ogg') ? 'ogg'
                   : mimeType.includes('wav') ? 'wav'
                   : 'webm'

    // multer memoryStorage gives req.file.buffer (Buffer).
    // If for any reason buffer is absent (stream-based multer variant), read it.
    let fileBuffer: Buffer
    if (req.file.buffer) {
      fileBuffer = req.file.buffer
    } else if ((req.file as any).stream) {
      const chunks: Buffer[] = []
      for await (const chunk of (req.file as any).stream) chunks.push(chunk as Buffer)
      fileBuffer = Buffer.concat(chunks)
    } else {
      res.status(500).json({ ok: false, error: 'Audio buffer unavailable — check multer storage config.' })
      return
    }

    if (fileBuffer.length < 100) {
      res.status(400).json({ ok: false, error: 'Audio too short or empty.' })
      return
    }

    // `new File(...)` is not available in all Node.js versions.
    // Use the SDK's toFile() helper — works in Node 18+.
    let transcription: string
    if (groqKey) {
      const { default: Groq, toFile } = await import('groq-sdk')
      const groq      = new Groq({ apiKey: groqKey })
      const audioFile = await toFile(fileBuffer, `voice.${ext}`, { type: mimeType })
      const result    = await groq.audio.transcriptions.create({
        file:            audioFile,
        model:           'whisper-large-v3-turbo',
        language:        lang && lang !== 'en' ? lang : undefined,
        response_format: 'text',
      })
      transcription = typeof result === 'string' ? result : (result as any).text ?? ''
    } else {
      const { default: OpenAI, toFile } = await import('openai')
      const openai    = new OpenAI({ apiKey: openaiKey })
      const audioFile = await toFile(fileBuffer, `voice.${ext}`, { type: mimeType })
      const result    = await openai.audio.transcriptions.create({
        file:            audioFile,
        model:           'whisper-1',
        language:        lang && lang !== 'en' ? lang : undefined,
        response_format: 'text',
      })
      transcription = typeof result === 'string' ? result : (result as any).text ?? ''
    }

    const text = transcription.trim()
    res.json({ ok: true, text })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: `Transcription failed: ${msg}` })
  }
})

/* ─── Echo API ────────────────────────────────────────────────────────── */

// GET /api/echo/:wallet — load full Echo state
app.get('/api/echo/:wallet', async (req, res) => {
  try {
    const data = await readEchoData(req.params.wallet)
    res.json({ ok: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// POST /api/echo/:wallet/mode — switch mode
app.post('/api/echo/:wallet/mode', async (req, res) => {
  try {
    const { mode } = req.body as { mode: 'basic' | 'medium' | 'high' }
    if (!['basic', 'medium', 'high'].includes(mode)) {
      res.status(400).json({ ok: false, error: 'Invalid mode' }); return
    }
    const data = await readEchoData(req.params.wallet)
    data.mode  = mode
    await writeEchoData(req.params.wallet, data)
    res.json({ ok: true, mode })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// POST /api/echo/:wallet/rules — parse + add a rule
app.post('/api/echo/:wallet/rules', async (req, res) => {
  try {
    const { raw } = req.body as { raw: string }
    if (!raw?.trim()) { res.status(400).json({ ok: false, error: 'Rule text required' }); return }

    const { parsed, interpretation } = await parseRule(raw.trim())

    const rule: EchoRule = {
      id:        crypto.randomUUID(),
      raw:       raw.trim(),
      parsed,
      active:    true,
      createdAt: Date.now(),
    }

    const data = await readEchoData(req.params.wallet)
    data.rules.push(rule)
    await writeEchoData(req.params.wallet, data)
    res.json({ ok: true, rule, interpretation })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// DELETE /api/echo/:wallet/rules/:id
app.delete('/api/echo/:wallet/rules/:id', async (req, res) => {
  try {
    const data  = await readEchoData(req.params.wallet)
    data.rules  = data.rules.filter(r => r.id !== req.params.id)
    await writeEchoData(req.params.wallet, data)
    res.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// POST /api/echo/:wallet/score — recalculate and store Echo Score
app.post('/api/echo/:wallet/score', async (req, res) => {
  try {
    const { portfolio, naviPositions } = req.body
    const score = calculateEchoScore(portfolio, naviPositions ?? null)
    const insights = scoreInsights(score)

    const data = await readEchoData(req.params.wallet)
    data.echoScore = score
    await writeEchoData(req.params.wallet, data)
    res.json({ ok: true, score, insights })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// POST /api/echo/:wallet/session-key — generate ephemeral keypair + return PTB for user to sign
app.post('/api/echo/:wallet/session-key', async (req, res) => {
  try {
    const { mode, packageId, expiryDays = 7 } = req.body as {
      mode:      'medium' | 'high'
      packageId: string
      expiryDays?: number
    }
    if (!packageId) { res.status(400).json({ ok: false, error: 'packageId required' }); return }

    const keypair    = generateSessionKeypair()
    const sessionAddr = keypair.getPublicKey().toSuiAddress()
    const limits     = MODE_LIMITS[mode]
    const expiresAt  = Date.now() + expiryDays * 24 * 60 * 60 * 1000

    // Store private key on Walrus
    const secretKey = keypair.getSecretKey()
    await storeSessionKey(req.params.wallet, secretKey instanceof Uint8Array ? secretKey : Buffer.from(secretKey as any))

    // Build unsigned PTB for the user to sign with their main wallet
    const ptbB64 = await buildSessionAuthPtb({
      packageId,
      sessionAddr,
      maxPerTx:  limits.maxPerTx,
      maxPerDay: limits.maxPerDay,
      expiresAt,
    })

    res.json({
      ok: true,
      sessionAddress: sessionAddr,
      expiresAt,
      ptbB64,         // user must sign this with their main wallet
      limits: {
        maxPerTx:  limits.maxPerTx.toString(),
        maxPerDay: limits.maxPerDay.toString(),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// POST /api/echo/:wallet/session-key/confirm — store auth object ID after user signed
app.post('/api/echo/:wallet/session-key/confirm', async (req, res) => {
  try {
    const { authObjectId, sessionAddress, expiresAt, maxAmountPerTx, maxAmountPerDay } = req.body
    const data = await readEchoData(req.params.wallet)
    data.sessionKeyMetadata = { publicKey: sessionAddress, authObjectId, expiresAt, maxAmountPerTx, maxAmountPerDay }
    await writeEchoData(req.params.wallet, data)
    res.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// DELETE /api/echo/:wallet/session-key — revoke
app.delete('/api/echo/:wallet/session-key', async (req, res) => {
  try {
    const data = await readEchoData(req.params.wallet)
    delete data.sessionKeyMetadata
    await writeEchoData(req.params.wallet, data)
    res.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// POST /api/echo/:wallet/parse-rule — parse only, don't save (for preview)
app.post('/api/echo/:wallet/parse-rule', async (req, res) => {
  try {
    const { raw } = req.body as { raw: string }
    if (!raw?.trim()) { res.status(400).json({ ok: false, error: 'Rule text required' }); return }
    const result = await parseRule(raw.trim())
    res.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── Health ─────────────────────────────────────────────────────────── */

app.get('/api/health', (_, res) => {
  res.json({ ok: true, version: '2.1.0', features: ['guardian', 'navi', 'dca', 'conditions', 'memory', 'alerts', 'contacts', 'voice', 'echo'] })
})

/* ─── Start ───────────────────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`\n  ⚡ Vektor OS  →  http://localhost:${PORT}`)
  console.log(`  Features    →  Guardian · NAVI · DCA · Conditions · Memory · Alerts`)
  try {
    const p = activeProvider()
    const label = p === 'anthropic' ? 'Claude (claude-sonnet-4)' : p === 'groq' ? 'Groq (llama-3.3-70b)' : 'Gemini (gemini-2.0-flash)'
    console.log(`  AI parser   →  ${label}\n`)
  } catch {
    console.log(`  AI parser   →  ⚠️  No API key set (ANTHROPIC_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY)\n`)
  }

  startScheduler()
  startConditionMonitor()
  startAlertMonitor()
})
