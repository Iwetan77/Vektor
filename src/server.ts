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

// BigInt values in res.json() are handled via Express's json replacer below.
// Do NOT patch BigInt.prototype.toJSON — that hijacks SDK-internal JSON.stringify
// calls (e.g. Aftermath PTB builder expects BigInt serialized as "1000000n" but
// the prototype patch emits "1000000", causing HTTP 400 from the Aftermath API).

import fs               from 'fs'
import path             from 'path'
import express          from 'express'
import cors             from 'cors'
import rateLimit         from 'express-rate-limit'
import multer           from 'multer'
// routex-sui is lazy-loaded to avoid startup crash on Vercel (cetus-sdk CJS requires ESM @mysten/sui)
let _RoutexClass: (new (network: string) => any) | null = null
async function loadRoutex() {
  if (!_RoutexClass) {
    const mod = await import('routex-sui')
    _RoutexClass = mod.default as new (network: string) => any
  }
  return _RoutexClass
}
import { complete, activeProvider, LANG_NAMES, SUPPORTED_LANGS } from './ai/client.js'
import {
  loadContacts, addContact, removeContact, listContacts, lookupContact,
  createGroup, addGroupMember, listGroups, lookupGroup, resolveGroupMembers,
  incrementPaymentCount,
} from './contacts/index.js'
import { isSuiName, resolveSuiName, reverseSuiName } from './suins/resolver.js'
import { walrusHealthCheck } from './walrus/client.js'

import { parseIntent }          from './parser/intent.js'
import { validateIntent }       from './parser/validate.js'
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
  createInviteLink, getInviteLink, touchInviteLink, markInviteClaimed,
  syncStoreFromKV,
} from './db/store.js'
import {
  getMemory, saveMemory, buildMemoryContext,
  getUnseenAlerts, markAlertsSeen, updatePortfolioSnapshot,
  addAlert, incrementIntentCount, logIntent, updateIntentStatus, addAdvice, getAdvice,
  getPreferredLanguage, setPreferredLanguage,
} from './memory/index.js'
import { startScheduler, runScheduleTick }        from './scheduler/worker.js'
import { startConditionMonitor, runConditionTick, getCurrentPrice, getAllPrices } from './conditions/monitor.js'
import { startAlertMonitor, registerWallet }     from './alerts/monitor.js'
import { readEchoData, writeEchoData }           from './echo/walrus.js'
import { calculateEchoScore, scoreInsights }     from './echo/score.js'
import { parseRule }                             from './echo/rules.js'
import { generateSessionKeypair, storeSessionKey, buildSessionAuthPtb, DEFAULT_LIMITS } from './echo/session.js'
import type { EchoRule } from './echo/types.js'
import { requireWalletSig, requireWalletSigOrWorkerSecret, requireWalletSigOrZkLogin } from './middleware/requireWalletSig.js'
import { getConditionById } from './db/store.js'
import { registerZkLoginRoutes } from './auth/zklogin-routes.js'

/* ─── VektorRegistry — local JSON counter ────────────────────────────────── */

// Vercel's filesystem is read-only except /tmp, so writable data must live there.
const DATA_DIR = process.env.VERCEL ? '/tmp/vektor-data' : path.resolve(process.cwd(), 'data')
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json')

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
// Serialize BigInt values as decimal strings only in res.json() responses.
// Scoped to Express output — does NOT touch BigInt.prototype, so SDK-internal
// JSON.stringify calls (e.g. Aftermath PTB builder using "1000000n" format) are unaffected.
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value
)
const PORT   = 3001

// Hard ceiling on the whole getQuote call.
// Worst-case: 5 s (direct, waiting for 7K) + 6 s hop cap, parallel = 6 s
// pathfinder + 2 s gas estimate = ~8 s. 18 s gives 10 s of headroom.
const QUOTE_MS = 18_000

// Routex maintains internal SDK clients (DeepBook, Cetus, Aftermath, 7K, …)
// that pay a 5-15s cold-start cost on first use. Sharing one instance across
// requests warms those clients once and keeps subsequent quotes fast.
//
// Safety: the constructor's `sender` argument is only used as a SIMULATION
// default for downstream SDK init. Every call site passes `senderAddress`
// explicitly via `getQuote({ senderAddress })`, and `buildFromRoute` uses the
// per-call sender for `tx.setSender(...)`. So one shared instance handles
// any user safely.
//
// Memoized by network because `setNetwork(network)` is called in the
// constructor and would mutate global state if we mixed networks.
const routexCache = new Map<string, any>()
async function createRoutex(network: 'mainnet', _sender: string) {
  let cached = routexCache.get(network)
  if (!cached) {
    const RoutexClass = await loadRoutex()
    cached = new RoutexClass(network)
    routexCache.set(network, cached)
  }
  return cached
}

// Serialize BigInt values as strings so res.json() never throws
app.set('json replacer', (_key: string, val: unknown) =>
  typeof val === 'bigint' ? val.toString() : val
)

const SIM_ADDR = '0x0000000000000000000000000000000000000000000000000000000000000001'

/**
 * Intent types whose work is only half-done when /api/intent returns: the server
 * builds the quote/PTB (ok:true) but the browser still has to sign + submit it,
 * which can fail. Their History record stays 'pending' until the client reports
 * the real outcome via POST /api/intent-status. Everything not in this set
 * (read-only queries, schedule/condition creation, onboard) is complete on return.
 */
const NEEDS_CLIENT_SIGNATURE: ReadonlySet<string> = new Set([
  'swap', 'buy_memecoin', 'sell_memecoin', 'exit_at_profit', 'exit_at_loss', 'exit',
  'compound', 'rebalance', 'risk_qualified',
  'send', 'contact_payment', 'batch_payment', 'split_payment',
  'lend', 'borrow', 'repay',
])

/**
 * Strip common markdown so LLM prose renders as clean plain text in the chat
 * bubble (which is not a markdown renderer). Removes **bold**, __bold__, inline
 * `code`, and # headings — the asterisks were showing up literally.
 */
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .trim()
}

const TOKEN_DECIMALS: Record<string, number> = {
  SUI: 1e9, USDC: 1e6, USDT: 1e6, DEEP: 1e6, WETH: 1e8, WBTC: 1e8, BUCK: 1e9,
  // Sui ecosystem tokens — match routex-sui@1.4.2's MAINNET_TOKENS registry exactly
  WAL: 1e9, AUSD: 1e6, NAVX: 1e9, HASUI: 1e9, AFSUI: 1e9, VSUI: 1e9, STSUI: 1e9, HAWAL: 1e9,
  NS: 1e6, SEND: 1e6, CETUS: 1e9, TURBOS: 1e9, FLX: 1e8, SCA: 1e9, BLUE: 1e9, SUIP: 1e9,
  LOFI: 1e9, BLUB: 100, HIPPO: 1e9, FUD: 1e5, OCEAN: 1e9, BONK: 1e5, MEME: 1e9,
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

/**
 * Add one or more non-SUI token transfers to a transaction by explicitly
 * selecting the sender's coin objects on-chain.
 *
 * We CANNOT use `coinWithBalance` here: it produces an unresolved intent that
 * `tx.serialize()` refuses to encode ("Unknown transaction $Intent,$kind") and
 * `tx.toJSON()` will only resolve with a client. Since this PTB is serialized
 * and shipped to the browser to be signed (zkLogin / wallet), we resolve coins
 * up front into concrete object references so the result serializes cleanly.
 *
 * Mirrors the coin-selection pattern proven in the /onboard claim handler.
 */
async function addTokenTransfers(
  tx: any,
  coinType: string,
  symbol: string,
  owner: string,
  transfers: { amountBase: bigint; recipient: string }[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const network = (process.env.SUI_NETWORK ?? 'mainnet') as 'mainnet' | 'testnet' | 'devnet'
  const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import('@mysten/sui/jsonRpc')
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network), network })

  // Page through all of the owner's coins of this type.
  const coins: { coinObjectId: string; balance: string }[] = []
  let cursor: string | null | undefined = undefined
  do {
    const page = await client.getCoins({ owner, coinType, cursor: cursor ?? null, limit: 50 })
    coins.push(...page.data)
    cursor = page.hasNextPage ? page.nextCursor : null
  } while (cursor)

  if (coins.length === 0) {
    return { ok: false, error: `You don't hold any ${symbol}.` }
  }
  const total  = coins.reduce((a, c) => a + BigInt(c.balance), 0n)
  const needed = transfers.reduce((a, t) => a + t.amountBase, 0n)
  if (total < needed) {
    const dec  = TOKEN_DECIMALS[symbol] ?? 1e9
    const have = (Number(total)  / dec).toFixed(dec >= 1e9 ? 4 : 6)
    const need = (Number(needed) / dec).toFixed(dec >= 1e9 ? 4 : 6)
    return { ok: false, error: `Insufficient ${symbol} balance. You have ${have} ${symbol} but this needs ${need} ${symbol}.` }
  }

  // Merge everything into the first coin, then split exact amounts off it.
  const primary = tx.object(coins[0].coinObjectId)
  if (coins.length > 1) {
    tx.mergeCoins(primary, coins.slice(1).map(c => tx.object(c.coinObjectId)))
  }
  for (const t of transfers) {
    const [out] = tx.splitCoins(primary, [tx.pure.u64(t.amountBase)])
    tx.transferObjects([out], t.recipient)
  }
  return { ok: true }
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

/* ─── CORS allowlist ───────────────────────────────────────────────────── */
const ALLOWED_ORIGINS = (process.env.VEKTOR_ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean)

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true
  // Allow this app's own Vercel deployment(s) — production and preview URLs.
  try {
    const host = new URL(origin).hostname
    if (host === 'localhost' || host === '127.0.0.1') return true
    if (host.endsWith('.vercel.app')) return true
  } catch { /* malformed origin → reject below */ }
  return false
}

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin/no-origin (curl, server-to-server) requests.
    if (!origin) return cb(null, true)
    if (isAllowedOrigin(origin)) return cb(null, true)
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  credentials: true,
}))
app.use(express.json())

// Pull the latest durable store (Upstash KV when configured) into the in-memory
// copy before handlers read it, so a cold lambda — or a different instance than
// the one that wrote — sees current invites/conditions/schedules. Throttled
// internally (no-op within its TTL), and a no-op entirely when KV isn't set.
app.use(async (_req, _res, next) => {
  try { await syncStoreFromKV() } catch { /* fall back to in-memory cache */ }
  next()
})

/* ─── Rate limiting (10/min/IP on hot user-input routes) ─────────────── */
const intentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:  { ok: false, error: 'rate limit exceeded' },
  // Bypass rate limiter for local smoke tests when SMOKE_TEST_KEY matches.
  skip: (req) => {
    const k = process.env.SMOKE_TEST_KEY
    return !!k && req.headers['x-smoke-key'] === k
  },
})
app.use('/api/intent',     intentLimiter)
app.use('/api/transcribe', intentLimiter)

/* ─── zkLogin (Google → Shinami → Sui) ──────────────────────────────────── */
registerZkLoginRoutes(app)

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/intent  — unified intent handler
   Body: { text: string, senderAddress?: string }
   Returns unified response based on intent_type
───────────────────────────────────────────────────────────────────────── */

app.post('/api/intent', async (req, res) => {
  // Track the intent record id so we can flip pending→success/failed on any exit
  let intentRecordId: string | null = null
  let intentSender:   string | null = null
  const markFailed = () => {
    if (intentSender && intentRecordId) {
      try { updateIntentStatus(intentSender, intentRecordId, 'failed') } catch {}
    }
  }
  // Auto-update the history record's status from the response.
  //
  //   • ok === false                          → failed (parse/validation/balance rejected it)
  //   • write intent that needs client signing → leave PENDING; the browser builds + signs
  //                                              the PTB afterward and reports the real outcome
  //                                              via POST /api/intent-status. Marking it
  //                                              'success' here is the bug that made failed
  //                                              swaps/sends show as successful in History.
  //   • everything else (read-only, schedule/condition created, onboard) → success now.
  //
  // We also inject `recordId` into every successful body so the client knows which
  // record to update once signing completes or fails.
  const originalJson = res.json.bind(res)
  res.json = ((body: any) => {
    if (intentSender && intentRecordId && body && typeof body === 'object') {
      if (body.ok !== false && body.recordId === undefined) body.recordId = intentRecordId
      const status: 'success' | 'failed' | 'pending' =
        body.ok === false                            ? 'failed'  :
        NEEDS_CLIENT_SIGNATURE.has(body.intent_type) ? 'pending' :
                                                       'success'
      try { updateIntentStatus(intentSender, intentRecordId, status) } catch {}
    }
    return originalJson(body)
  }) as typeof res.json
  try {
    const { text, senderAddress, firstName } = req.body as { text: string; senderAddress?: string; firstName?: string }
    const sender = senderAddress || SIM_ADDR
    if (!text?.trim()) { res.status(400).json({ ok: false, error: 'text is required' }); return }
    intentSender = sender

    // ── Fast-path: /onboard command — skip LLM parsing ──────────────────────
    if (/^\/?onboard\b/i.test(text.trim())) {
      const BASE = process.env.VEKTOR_URL ?? 'http://localhost:5173'

      // Parse the token first ("0.0001 SUI", "5 USDC"). Onboarding pays out
      // SUI or USDC — anything else falls back to USDC.
      const tokenMatch = text.match(/\b(sui|usdc)\b/i)
      const token      = (tokenMatch?.[1] ?? 'USDC').toUpperCase()

      // Parse amount: "$5", "5 USDC", "0.0001 SUI", "with 5", "with $5"
      let amount = 1
      const dollarMatch  = text.match(/\$\s*(\d+(?:\.\d+)?)/)
      const tokenAmtMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:sui|usdc)\b/i)
      const withMatch    = text.match(/\bwith\s+\$?\s*(\d+(?:\.\d+)?)/i)
      const matchedAmt   = dollarMatch?.[1] ?? tokenAmtMatch?.[1] ?? withMatch?.[1]
      if (matchedAmt) {
        const n = parseFloat(matchedAmt)
        if (Number.isFinite(n) && n > 0) amount = n
      }

      // Parse recipient name (anything after /onboard before "with"/"$"/digit)
      const nameMatch = text.match(/^\/?onboard\s+([A-Za-z][A-Za-z0-9 _-]*?)(?:\s+with\b|\s*\$|\s+\d|\s*$)/i)
      const recipient = nameMatch?.[1]?.trim() ?? null

      let inviteLink: string | null = null
      let invite: { token: string; amount: number } | null = null
      if (sender !== SIM_ADDR) {
        invite = createInviteLink(sender, amount, token)
        inviteLink = `${BASE}?invite=${invite.token}`
      }

      // USDC reads naturally with a "$"; SUI does not.
      const amountLabel = token === 'USDC' ? `$${amount} USDC` : `${amount} ${token}`
      const who = recipient ? recipient : 'a friend'
      const msg = inviteLink
        ? `Send this link to ${who} to claim ${amountLabel}: \`${inviteLink}\``
        : 'Connect your wallet to create a funded invite.'

      res.json({
        ok:          true,
        intent_type: 'onboard',
        language:    'en',
        inviteLink,
        amount,
        token,
        recipient,
        message:     msg,
        actionLabel: `· ONBOARD${recipient ? ` · ${recipient}` : ''} · ${amountLabel}`,
      })
      return
    }

    // ── Fast-path: greetings / small talk — skip the LLM, answer warmly ──────
    // "hi", "hello", "hey vektor", "gm", "yo", "good morning" → a friendly,
    // personalized hello. Saves a Groq call and keeps Vektor feeling human.
    if (/^\s*(hi|hello|hey|yo|hiya|gm|sup|good\s*(morning|afternoon|evening))\b[\s!.,]*(vektor)?[\s!.,]*$/i.test(text)) {
      const who = firstName?.trim() ? firstName.trim().split(/\s+/)[0] : null
      res.json({
        ok: true,
        intent_type: 'general',
        language: 'en',
        message: who
          ? `Hey ${who} — what can I do for you today? You can swap, lend, send, automate, or just ask about your wallet.`
          : `Hey — what can I do for you today? You can swap, lend, send, automate, or just ask about your wallet.`,
        actionLabel: '· VEKTOR',
      })
      return
    }

    // Load memory context for the user
    const memCtx  = sender !== SIM_ADDR ? buildMemoryContext(sender) : undefined
    const parsed  = await parseIntent(text, memCtx)

    // ── Post-parse validation gate ─────────────────────────────────────
    // Catches missing amounts, same-token swaps, missing recipients/triggers
    // BEFORE we quote / build / sign anything. Pure function — see
    // src/parser/validate.ts and tests/intents.correctness.ts.
    {
      const v = validateIntent(parsed)
      if (!v.ok) {
        res.json({ ok: false, error: v.clarify, language: (parsed as any).language ?? 'en' })
        return
      }
    }

    // Guard: if the parser returned 'send' or 'contact_payment' but the target
    // (recipient / recipient_name) is a known token symbol, the LLM confused
    // "swap X to TOKEN" or "swap X for TOKEN" with a transfer. Reclassify as swap.
    const KNOWN_TOKEN_SYMBOLS = new Set([
      'SUI', 'USDC', 'USDT', 'WETH', 'WBTC', 'DEEP',
      'AFSUI', 'HASUI', 'VSUI', 'STSUI', 'BUCK', 'WAL', 'HAWAL',
      'AUSD', 'NAVX', 'NS', 'SEND', 'CETUS', 'TURBOS', 'FLX', 'SCA', 'BLUE', 'SUIP',
      'LOFI', 'BLUB', 'OCEAN', 'HIPPO', 'FUD', 'BONK', 'MEME',
    ])
    if (parsed.intent_type === 'send' || parsed.intent_type === 'contact_payment') {
      const target = (
        parsed.recipient ??
        (parsed as any).recipient_name ??
        parsed.output_goal ??
        ''
      ).toUpperCase()
      if (KNOWN_TOKEN_SYMBOLS.has(target)) {
        // Same-token guard — don't silently turn "send N USDC to USDC" into a wasteful USDC→USDC swap.
        const source = (parsed.input_asset ?? '').toUpperCase()
        if (source && source === target) {
          // Leave intent_type as 'send' with no recipient so the send handler rejects cleanly below.
          // (Handled by the unified send-resolution path: no 0x, not a SuiNS name, not a contact → asks for a recipient.)
          parsed.recipient                 = null
          ;(parsed as any).recipient_name = null
        } else {
          parsed.output_goal        = target
          parsed.recipient          = null
          ;(parsed as any).recipient_name = null
          parsed.intent_type        = 'swap'
        }
      }
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
      if (intent) intentRecordId = logIntent(sender, { type: intent, summary: text.slice(0, 120), status: 'pending' })
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

      const rawMessage = await complete({
        system: 'You are Vektor, a DeFi portfolio analyst on Sui. Analyze the user\'s portfolio and give 3-5 specific, actionable recommendations. Mention yield opportunities, risk factors, and diversification. Be concise but specific. Write in plain text only — do NOT use markdown formatting (no **bold**, no #, no backticks).',
        prompt: `Wallet: ${sender.slice(0, 8)}…\nTotal: ${totalStr}\nHoldings: ${assets || 'none'}\n${naviInfo}`,
        maxTokens: 400, lang,
      }).catch(() => `Portfolio value: ${totalStr}. ${assets || 'No tokens detected'}.`)
      const message = stripMarkdown(rawMessage)
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
      const token        = (parsed.input_asset ?? 'SUI').toUpperCase()
      const amount       = parsed.input_amount ?? 0
      const rawRecipient = parsed.recipient ?? ''

      // Resolution order: raw 0x → existing contact (incl. a hallucinated ".sui"
      // suffix stripped — the parser sometimes guesses ".sui" on plain names) → SuiNS name.
      // Saved contacts take priority: a user who saved "ebube" should never see a SuiNS
      // resolution error just because the parser appended ".sui" to their literal text.
      let recipient   = rawRecipient
      let displayName = ''
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(rawRecipient)) {
        const bareCandidate = rawRecipient.replace(/^@/, '').replace(/\.sui$/i, '')
        const contactAddr = (rawRecipient && sender !== SIM_ADDR)
          ? await lookupContact(sender, rawRecipient).catch(() => null)
            ?? (bareCandidate !== rawRecipient ? await lookupContact(sender, bareCandidate).catch(() => null) : null)
          : null
        if (contactAddr) {
          recipient   = contactAddr
          displayName = bareCandidate
        } else if (isSuiName(rawRecipient)) {
          const resolved = await resolveSuiName(rawRecipient)
          if (!resolved) {
            markFailed()
            res.json({ ok: false, error: `Couldn't resolve ${rawRecipient} — that SuiNS name isn't registered.`, language: lang })
            return
          }
          recipient   = resolved
          displayName = rawRecipient.startsWith('@') ? rawRecipient.slice(1) + '.sui' : rawRecipient.toLowerCase()
        }
      } else {
        // Raw 0x — try reverse SuiNS lookup so the confirmation shows "name.sui (0x..)"
        const rev = await reverseSuiName(rawRecipient).catch(() => null)
        if (rev) displayName = rev
      }

      // ── Balance check — reject before showing a confirmation we can't honor ─
      if (sender !== SIM_ADDR) {
        const actual = await getTokenBalance(sender, token).catch(() => Infinity)
        if (actual < amount) {
          markFailed()
          const have   = actual.toFixed(TOKEN_DECIMALS[token] >= 1e9 ? 4 : 6)
          const need   = amount.toFixed(TOKEN_DECIMALS[token] >= 1e9 ? 4 : 6)
          const errEn  = `Insufficient ${token} balance. You have ${have} ${token} but want to send ${need} ${token}.`
          const errMsg = lang === 'en' ? errEn : await complete({
            system: 'You are Vektor. Translate this error message exactly, keeping token symbols and numbers unchanged.',
            prompt: errEn, maxTokens: 80, lang,
          }).catch(() => errEn)
          res.json({ ok: false, error: errMsg, language: lang })
          return
        }
      }

      const target    = displayName
        ? `${displayName} (${recipient.slice(0, 8)}…${recipient.slice(-4)})`
        : `${recipient.slice(0, 8)}…${recipient.slice(-4)}`
      const sendMsgEn = `Ready to send ${amount} ${token} to ${target}. Confirm to proceed.`
      const sendMsg   = lang === 'en' ? sendMsgEn : await complete({
        system: 'You are Vektor. Translate this transfer confirmation exactly, keeping the address fragment unchanged.', prompt: sendMsgEn, maxTokens: 100, lang,
      }).catch(() => sendMsgEn)
      res.json({
        ok: true, intent_type: intent, parsedIntent: { ...parsed, recipient },
        language: lang,
        message:     sendMsg,
        actionLabel: `· SEND · ${amount} ${token}${displayName ? ` · ${displayName}` : ''}`,
        ptbType:     'send',
        ptbParams:   { token, amount, recipient, displayName: displayName || undefined },
      })
      return
    }

    /* ── Contact payment — resolve name → address, then treat as send ── */

    if (intent === 'contact_payment') {
      const token         = (parsed.input_asset ?? 'SUI').toUpperCase()
      const amount        = parsed.input_amount ?? 0
      const recipientName = (parsed as any).recipient_name as string | null ?? parsed.recipient ?? ''

      if (!recipientName) {
        markFailed()
        res.json({ ok: false, error: 'Who would you like to pay? Include their name.', language: lang })
        return
      }

      // Resolution order: raw 0x → existing contact (incl. a hallucinated ".sui"
      // suffix stripped) → SuiNS name. Saved contacts take priority — see the
      // matching comment in the 'send' branch above for why.
      let resolvedAddress: string | null = null
      const bareCandidate = recipientName.replace(/^@/, '').replace(/\.sui$/i, '')
      if (/^0x[0-9a-fA-F]{1,64}$/.test(recipientName)) {
        resolvedAddress = recipientName
      } else if (sender !== SIM_ADDR) {
        resolvedAddress = await lookupContact(sender, recipientName).catch(() => null)
        if (!resolvedAddress && bareCandidate !== recipientName) {
          resolvedAddress = await lookupContact(sender, bareCandidate).catch(() => null)
        }
      }
      if (!resolvedAddress && isSuiName(recipientName)) {
        resolvedAddress = await resolveSuiName(recipientName)
        if (!resolvedAddress) {
          markFailed()
          res.json({ ok: false, error: `Couldn't resolve ${recipientName} — that SuiNS name isn't registered.`, language: lang })
          return
        }
      }

      if (!resolvedAddress) {
        const askEn = `I don't have an address saved for "${recipientName}". What's their wallet address?`
        const askMsg = lang === 'en' ? askEn : await complete({
          system: 'You are Vektor. Translate this question exactly, keeping the name unchanged.',
          prompt: askEn, maxTokens: 80, lang,
        }).catch(() => askEn)
        res.json({ ok: true, intent_type: 'general', parsedIntent: parsed, language: lang, message: askMsg, actionLabel: '· CONTACT · NOT FOUND' })
        return
      }

      // ── Balance check — same as the send path ────────────────────────
      if (sender !== SIM_ADDR) {
        const actual = await getTokenBalance(sender, token).catch(() => Infinity)
        if (actual < amount) {
          markFailed()
          const have   = actual.toFixed(TOKEN_DECIMALS[token] >= 1e9 ? 4 : 6)
          const need   = amount.toFixed(TOKEN_DECIMALS[token] >= 1e9 ? 4 : 6)
          const errEn  = `Insufficient ${token} balance. You have ${have} ${token} but want to pay ${need} ${token}.`
          const errMsg = lang === 'en' ? errEn : await complete({
            system: 'You are Vektor. Translate this error message exactly, keeping token symbols and numbers unchanged.',
            prompt: errEn, maxTokens: 80, lang,
          }).catch(() => errEn)
          res.json({ ok: false, error: errMsg, language: lang })
          return
        }
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
        const rawAddr = steps[2] ?? parsed.recipient ?? ''
        const note    = steps[3] ?? ''
        if (!name || !rawAddr) {
          res.json({ ok: false, error: 'Usage: /contact add 0xAddress as "Name"', language: lang }); return
        }
        const resolvedAddr = await resolveAddressInput(rawAddr)
        if (!resolvedAddr.ok) {
          res.json({ ok: false, error: resolvedAddr.error, language: lang }); return
        }
        const address = resolvedAddr.address
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

        // Resolve member names: 0x → as-is → SuiNS (resolved sync below) → contact lookup
        const memberNames = steps.slice(2)
        const contactList = sender !== SIM_ADDR ? await listContacts(sender).catch(() => []) : []
        const members = await Promise.all(memberNames.map(async name => {
          if (/^0x[0-9a-fA-F]{1,64}$/.test(name)) return { name, address: name }
          if (isSuiName(name)) {
            const addr = await resolveSuiName(name)
            return { name, address: addr ?? '' }
          }
          const c = contactList.find(ct => ct.name.toLowerCase() === name.toLowerCase())
          return { name, address: c?.address ?? '' }
        })).then(arr => arr.filter(m => m.address !== ''))

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

      const routex  = await createRoutex('mainnet', sender)
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

      // Advice log — record what Vektor recommended so it stays consistent later.
      if (sender !== SIM_ADDR) {
        try {
          addAdvice(sender, {
            intentType:     intent,
            summary:        text.slice(0, 120),
            recommendation: `${report.level ?? 'reviewed'} risk · ${fromToken} → ${memeToken} · score ${report.score}/100`,
            riskScore:      report.score,
          })
        } catch { /* advice logging is best-effort */ }
      }

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

    // Same-token guard — a token-to-itself swap is a no-op that wastes gas + slippage.
    if (parsed.input_asset && parsed.output_goal && fromToken === toToken) {
      const errEn  = `Can't swap ${fromToken} for itself — did you mean to send it to someone?`
      const errMsg = lang === 'en' ? errEn : await complete({
        system: 'You are Vektor. Translate this error message exactly, keeping the token symbol unchanged.',
        prompt: errEn, maxTokens: 80, lang,
      }).catch(() => errEn)
      res.json({ ok: false, error: errMsg, language: lang })
      return
    }

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

    const routex = await createRoutex('mainnet', sender)
    let quote: any
    try {
      quote = await Promise.race([
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
    } catch (qErr: any) {
      const msg: string = qErr?.message ?? String(qErr)
      // Routex throws "Unknown token: X. Supported: ..." for tokens not yet in its registry.
      // Surface a friendly error instead of leaking SDK internals.
      if (msg.startsWith('Unknown token:')) {
        const unsupported = msg.split('.')[0].replace('Unknown token: ', '')
        const errEn = `${unsupported} can't be swapped directly yet — it's not in the routing engine's registry. ` +
          `Supported tokens: SUI, USDC, USDT, WETH, WBTC, DEEP, BUCK, AUSD, NAVX, HASUI, AFSUI, VSUI, STSUI, WAL, ` +
          `NS, SEND, CETUS, TURBOS, FLX, SCA, BLUE, SUIP, FUD, LOFI, HIPPO, BLUB. ` +
          `Routing support for other tokens is added as the SDK is updated.`
        const errMsg = lang === 'en' ? errEn : await complete({
          system: 'You are Vektor. Translate this error message, keeping all token symbols unchanged.',
          prompt: errEn, maxTokens: 120, lang,
        }).catch(() => errEn)
        res.json({ ok: false, error: errMsg, language: lang })
        return
      }
      throw qErr
    }

    // Guard: Routex silently returns an empty Transaction when buildFromRoute fails.
    // Detect it here — before Guardian — so the user never sees a confirmable
    // card for a swap that will execute as a no-op on-chain.
    {
      const ptbCheck = JSON.parse(quote.ptb.serialize() as string)
      if (!ptbCheck.transactions?.length) {
        const errEn  = `Could not build the swap transaction for ${fromToken} → ${toToken}. The DEX route exists but the transaction could not be constructed — this is a temporary issue. Try again in a moment or use a different amount.`
        const errMsg = lang === 'en' ? errEn : await complete({
          system: 'You are Vektor. Translate this error message exactly, keeping token symbols unchanged.',
          prompt: errEn, maxTokens: 100, lang,
        }).catch(() => errEn)
        res.json({ ok: false, error: errMsg, language: lang })
        return
      }
    }

    const quoteWithSym = { ...quote, fromSymbol: fromToken, toSymbol: toToken }
    const report       = await runGuardian(quoteWithSym, sender, null, lang)

    // Advice log — record what Vektor recommended so it stays consistent later.
    if (sender !== SIM_ADDR) {
      try {
        addAdvice(sender, {
          intentType:     intent,
          summary:        text.slice(0, 120),
          recommendation: `${report.level ?? 'reviewed'} risk · ${fromToken} → ${toToken} · score ${report.score}/100`,
          riskScore:      report.score,
        })
      } catch { /* advice logging is best-effort */ }
    }

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
    markFailed()
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
      const simulatedQuote = {
        amountIn:    Math.abs(Number(inB?.amount ?? 0)).toString(),
        amountOut:   Math.abs(Number(outB?.amount ?? 0)).toString(),
        priceImpact: 0.001,
        gasEstimate: '5000000',
        route:       [],
        fromSymbol:  'SUI',
        toSymbol:    'USDC',
      }
      const report = await runGuardian(simulatedQuote, sender, null)
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

app.delete('/api/schedule/:id', requireWalletSigOrZkLogin({
  resolveWallet: req => getScheduledById(String(req.params.id))?.wallet,
}), (req, res) => {
  const ok = cancelScheduled(req.params.id)
  res.json({ ok })
})

/* ─── Conditions CRUD ────────────────────────────────────────────────── */

app.get('/api/conditions/:wallet', (req, res) => {
  res.json({ ok: true, conditions: getConditions(req.params.wallet) })
})

app.delete('/api/conditions/:id', requireWalletSigOrZkLogin({
  resolveWallet: req => getConditionById(String(req.params.id))?.wallet,
}), (req, res) => {
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
  res.json({ ok: true, invite: {
    creatorWallet: invite.creatorWallet,
    createdAt:     invite.createdAt,
    uses:          invite.uses,
    amount:        invite.amount,
    token_symbol:  invite.token_symbol,
    claimed:       invite.claimed,
  } })
})

/* ─── Claim a funded invite — testnet USDC from VEKTOR_FUNDING_KEY ────── */

// HARD CONSTRAINTS, enforced by the handler below:
//   • Coin type:        SUI (gas coin) or USDC (TESTNET_USDC_COIN_TYPE)
//   • Amount:           exactly invite.amount, sanity-capped at 50
//   • Recipient:        only the body's recipientAddress, no other target
//   • One-shot:         rejects if already claimed
const TESTNET_USDC_COIN_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:  { ok: false, error: 'claim rate limit exceeded' },
})

app.post('/api/onboard/:token/claim', claimLimiter, async (req, res) => {
  try {
    const { recipientAddress } = req.body as { recipientAddress?: string }
    if (!recipientAddress || !/^0x[0-9a-fA-F]{1,64}$/.test(recipientAddress)) {
      res.status(400).json({ ok: false, error: 'recipientAddress required (hex Sui address)' }); return
    }

    const invite = getInviteLink(String(req.params.token))
    if (!invite) { res.status(404).json({ ok: false, error: 'Invite not found' }); return }
    if (invite.claimed) { res.status(409).json({ ok: false, error: 'Invite already claimed' }); return }
    if (invite.amount <= 0 || invite.amount > 50) {
      res.status(400).json({ ok: false, error: 'Invite amount out of allowed range (0, 50]' }); return
    }
    const tokenSym = (invite.token_symbol ?? 'USDC').toUpperCase()
    if (tokenSym !== 'USDC' && tokenSym !== 'SUI') {
      res.status(400).json({ ok: false, error: 'Only SUI and USDC invites are supported' }); return
    }

    const fundingKey = process.env.VEKTOR_FUNDING_KEY
    if (!fundingKey) { res.status(503).json({ ok: false, error: 'VEKTOR_FUNDING_KEY not configured' }); return }

    const [{ Ed25519Keypair }, { decodeSuiPrivateKey }, jsonRpcMod, { Transaction }] = await Promise.all([
      import('@mysten/sui/keypairs/ed25519'),
      import('@mysten/sui/cryptography'),
      import('@mysten/sui/jsonRpc'),
      import('@mysten/sui/transactions'),
    ])
    const SuiClient      = jsonRpcMod.SuiJsonRpcClient
    const getFullnodeUrl = jsonRpcMod.getJsonRpcFullnodeUrl

    const { secretKey } = decodeSuiPrivateKey(fundingKey)
    const keypair = Ed25519Keypair.fromSecretKey(secretKey)
    const sender  = keypair.getPublicKey().toSuiAddress()
    const network = (process.env.SUI_NETWORK ?? 'testnet') as 'testnet' | 'mainnet' | 'devnet'
    const client  = new SuiClient({ url: getFullnodeUrl(network), network })

    const tx = new Transaction()
    tx.setSender(sender)

    if (tokenSym === 'SUI') {
      // SUI: split directly from the gas coin and transfer.
      const SUI_DECIMALS = 9
      const amountBase = BigInt(Math.round(invite.amount * 10 ** SUI_DECIMALS))
      const [transferCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountBase)])
      tx.transferObjects([transferCoin], tx.pure.address(recipientAddress))
    } else {
      // USDC: pull the funding wallet's USDC coin objects, merge, split, transfer.
      const USDC_DECIMALS = 6
      const amountBase = BigInt(Math.round(invite.amount * 10 ** USDC_DECIMALS))
      const coins = await client.getCoins({ owner: sender, coinType: TESTNET_USDC_COIN_TYPE, limit: 50 })
      if (coins.data.length === 0) {
        res.status(503).json({ ok: false, error: 'Funding wallet has no USDC coin objects' }); return
      }
      const primary = tx.object(coins.data[0].coinObjectId)
      if (coins.data.length > 1) {
        tx.mergeCoins(primary, coins.data.slice(1).map((c: { coinObjectId: string }) => tx.object(c.coinObjectId)))
      }
      const [transferCoin] = tx.splitCoins(primary, [tx.pure.u64(amountBase)])
      tx.transferObjects([transferCoin], tx.pure.address(recipientAddress))
    }

    const result = await client.signAndExecuteTransaction({
      signer:      keypair,
      transaction: tx,
      options:     { showEffects: true },
    })

    if (result.effects?.status?.status !== 'success') {
      res.status(500).json({ ok: false, error: `claim tx failed: ${result.effects?.status?.error ?? 'unknown'}` }); return
    }

    markInviteClaimed(String(req.params.token), recipientAddress, result.digest)
    res.json({ ok: true, digest: result.digest, amount: invite.amount, token: tokenSym, recipient: recipientAddress })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
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

app.post('/api/execute-scheduled/:id', requireWalletSigOrZkLogin({
  resolveWallet: req => getScheduledById(String(req.params.id))?.wallet,
}), async (req, res) => {
  try {
    const { senderAddress } = req.body as { senderAddress?: string }
    const sender = senderAddress || SIM_ADDR

    // Use getScheduledById — looks up by ID regardless of active status because
    // markScheduledRun() already deactivated it before the alert was created.
    const scheduled = getScheduledById(req.params.id)
    if (!scheduled) {
      res.status(404).json({ ok: false, error: 'Scheduled intent not found' }); return
    }

    const fromToken      = scheduled.token.toUpperCase()
    const scheduledType  = scheduled.intent?.intent_type
    const amount         = scheduled.amount
    const lang           = sender !== SIM_ADDR ? getPreferredLanguage(sender) : 'en'

    // ── Dispatch: send vs swap ──────────────────────────────────────────
    // "send 0.001 SUI to adeniyi.sui in 1 minute" is parsed as
    // intent_type:"schedule" (the wrapper) — NOT "send" — so we can't branch
    // on intent_type. The real signal is the recipient: a scheduled transfer
    // carries a recipient and no swap target, whereas a scheduled swap carries
    // a targetToken/output_goal and no recipient. Detect a send by recipient
    // presence (and an explicit send/contact_payment type as a belt-and-braces
    // fallback for any record that did store the inner type).
    const recipient = scheduled.recipient ?? scheduled.intent?.recipient ?? null
    const swapTarget = (scheduled.targetToken ?? scheduled.intent?.output_goal ?? '').toUpperCase()
    const hasSwapTarget = !!swapTarget && swapTarget !== fromToken
    const isSend =
      scheduledType === 'send' ||
      scheduledType === 'contact_payment' ||
      (!!recipient && !hasSwapTarget)

    // Balance check — same shape for send and swap (need amount of fromToken).
    if (sender !== SIM_ADDR) {
      const actual = await getTokenBalance(sender, fromToken).catch(() => Infinity)
      if (actual < amount) {
        const errEn = `Insufficient ${fromToken} balance for scheduled ${isSend ? 'send' : 'swap'}. You have ${actual.toFixed(4)} ${fromToken} but need ${amount} ${fromToken}.`
        const errMsg = lang === 'en' ? errEn : await complete({
          system: 'You are Vektor. Translate this error message exactly, keeping token symbols and numbers unchanged.',
          prompt: errEn, maxTokens: 80, lang,
        }).catch(() => errEn)
        res.json({ ok: false, error: errMsg, language: lang }); return
      }
    }

    // ── SEND path: resolve recipient (raw 0x or SuiNS), return send-shape ──
    if (isSend) {
      const rawRecipient = recipient ?? ''
      if (!rawRecipient) {
        res.json({ ok: false, error: 'Scheduled send has no recipient.', language: lang }); return
      }
      let resolvedRecipient = rawRecipient
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(rawRecipient)) {
        if (isSuiName(rawRecipient)) {
          const r = await resolveSuiName(rawRecipient).catch(() => null)
          if (!r) {
            res.json({ ok: false, error: `Couldn't resolve ${rawRecipient} — that SuiNS name isn't registered.`, language: lang }); return
          }
          resolvedRecipient = r
        } else {
          res.json({ ok: false, error: `Recipient ${rawRecipient} isn't a valid address or SuiNS name.`, language: lang }); return
        }
      }

      const shortAddr = `${resolvedRecipient.slice(0, 8)}…${resolvedRecipient.slice(-4)}`
      const label     = rawRecipient.endsWith('.sui') ? rawRecipient : shortAddr
      res.json({
        ok:          true,
        intent_type: 'send',
        parsedIntent: { ...(scheduled.intent ?? {}), recipient: resolvedRecipient },
        language:    lang,
        message:     `Ready to send ${amount} ${fromToken} to ${label}.`,
        actionLabel: `· SCHEDULED SEND · ${amount} ${fromToken} → ${label}`,
        ptbType:     'send',
        ptbParams:   { token: fromToken, amount, recipient: resolvedRecipient },
      })
      return
    }

    // ── SWAP path (existing) ────────────────────────────────────────────
    const toToken = (scheduled.targetToken ?? scheduled.intent?.output_goal ?? 'USDC').toUpperCase()

    const amountIn = toBaseUnits(amount, fromToken)
    const routex   = await createRoutex('mainnet', sender)
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
    const routex = await createRoutex('mainnet', sender)
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

    // Guard: Routex silently returns an empty Transaction when buildFromRoute fails.
    // Reject here — never let an empty PTB reach the wallet.
    const ptbCheck = JSON.parse(ptbJson as string)
    if (!ptbCheck.transactions?.length) {
      res.status(500).json({
        ok: false,
        error: `Could not build swap transaction for ${from} → ${to}. The route exists but the DEX failed to construct the transaction — try again or use a different amount.`,
      })
      return
    }

    res.json({ ok: true, ptbJson })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── Final execution status for a History record ─────────────────────────
   The browser calls this after signing (or failing to sign) a write intent that
   /api/intent left 'pending'. Without it, a swap/send that fails client-side
   would stay misreported. recordId is the value /api/intent injected into its
   response body. */

app.post('/api/intent-status', (req, res) => {
  try {
    const { wallet, recordId, status } = req.body as {
      wallet?: string; recordId?: string; status?: string
    }
    if (!wallet || !recordId || (status !== 'success' && status !== 'failed' && status !== 'pending')) {
      res.status(400).json({ ok: false, error: 'wallet, recordId, and status (success|failed|pending) are required' })
      return
    }
    updateIntentStatus(wallet, recordId, status)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
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

/* ─── Advice log — what Vektor has recommended for this wallet ────────── */

app.get('/api/advice/:wallet', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50)
    res.json({ ok: true, advice: getAdvice(req.params.wallet, limit) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

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

/**
 * Normalize a contact/group address input. Accepts a raw 0x address OR a SuiNS
 * name (e.g. "mum.sui", "@mum") and resolves the name to its on-chain address
 * so we only ever store canonical 0x addresses. SuiNS resolves on mainnet.
 */
async function resolveAddressInput(
  input: string,
): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const raw = (input ?? '').trim()
  if (/^0x[0-9a-fA-F]{1,64}$/.test(raw)) return { ok: true, address: raw }
  if (isSuiName(raw)) {
    const resolved = await resolveSuiName(raw).catch(() => null)
    if (resolved) return { ok: true, address: resolved }
    return { ok: false, error: `Couldn't resolve ${raw} — that SuiNS name isn't registered.` }
  }
  return { ok: false, error: 'Address must be a 0x Sui address or a SuiNS name (e.g. mum.sui).' }
}

app.get('/api/contacts/:wallet', async (req, res) => {
  try {
    const contacts = await listContacts(req.params.wallet)
    const groups   = await listGroups(req.params.wallet)
    res.json({ ok: true, contacts, groups })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/contacts/:wallet', requireWalletSigOrZkLogin(), async (req, res) => {
  try {
    const { name, address, note } = req.body as { name: string; address: string; note?: string }
    if (!name || !address) { res.status(400).json({ ok: false, error: 'name and address required' }); return }
    const resolved = await resolveAddressInput(address)
    if (!resolved.ok) { res.status(400).json({ ok: false, error: resolved.error }); return }
    const contact = await addContact(req.params.wallet, name, resolved.address, note)
    res.json({ ok: true, contact })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/contacts/:wallet/:name', requireWalletSigOrZkLogin(), async (req, res) => {
  try {
    const removed = await removeContact(req.params.wallet, decodeURIComponent(req.params.name))
    res.json({ ok: removed })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/* ─── Groups ──────────────────────────────────────────────────────────── */

app.post('/api/groups/:wallet', requireWalletSigOrZkLogin(), async (req, res) => {
  try {
    const { name, members } = req.body as { name: string; members: { name: string; address: string }[] }
    if (!name) { res.status(400).json({ ok: false, error: 'group name required' }); return }
    // Resolve any SuiNS member addresses to canonical 0x before storing.
    const resolvedMembers: { name: string; address: string }[] = []
    for (const m of members ?? []) {
      const r = await resolveAddressInput(m.address)
      if (!r.ok) { res.status(400).json({ ok: false, error: `${m.name || 'member'}: ${r.error}` }); return }
      resolvedMembers.push({ name: m.name, address: r.address })
    }
    const group = await createGroup(req.params.wallet, name, resolvedMembers)
    res.json({ ok: true, group })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/groups/:wallet/:groupName/members', requireWalletSigOrZkLogin(), async (req, res) => {
  try {
    const { name, address } = req.body as { name: string; address: string }
    if (!name || !address) { res.status(400).json({ ok: false, error: 'name and address required' }); return }
    const r = await resolveAddressInput(address)
    if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return }
    const ok = await addGroupMember(req.params.wallet, decodeURIComponent(req.params.groupName), { name, address: r.address })
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
      // Non-SUI: resolve concrete coin objects so the PTB serializes for the browser.
      const r = await addTokenTransfers(
        tx, coinType, tokenUpper, senderAddress,
        members.map(m => ({ amountBase: amountMist, recipient: m.address })),
      )
      if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return }
    }

    const ptbJson = tx.serialize()
    res.json({ ok: true, ptbJson, recipientCount: members.length, totalAmount: amountPerPerson * members.length, token })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/* ─── Single-recipient transfer PTB ───────────────────────────────────── */

app.post('/api/send-ptb', async (req, res) => {
  try {
    const { senderAddress, recipient: rawRecipient, token, amount } = req.body as {
      senderAddress: string
      recipient:     string
      token:         string
      amount:        number
    }
    if (!senderAddress || !rawRecipient || !token || !amount || amount <= 0) {
      res.status(400).json({ ok: false, error: 'senderAddress, recipient, token, amount required' }); return
    }

    // Resolution order: raw 0x → SuiNS name → reject
    let recipient = rawRecipient
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(rawRecipient)) {
      if (isSuiName(rawRecipient)) {
        const resolved = await resolveSuiName(rawRecipient)
        if (!resolved) {
          res.status(400).json({ ok: false, error: `Couldn't resolve ${rawRecipient} — that SuiNS name isn't registered.` }); return
        }
        recipient = resolved
      } else {
        res.status(400).json({ ok: false, error: 'recipient must be a hex Sui address or a SuiNS name (e.g. ivan.sui)' }); return
      }
    }

    const { Transaction } = await import('@mysten/sui/transactions')
    const tx = new Transaction()
    tx.setSender(senderAddress)

    const tokenUpper = token.toUpperCase()
    const coinType   = TOKEN_COIN_TYPES[tokenUpper] ?? '0x2::sui::SUI'
    const decimals   = TOKEN_DECIMALS[tokenUpper]   ?? 1e9
    const amountBase = BigInt(Math.round(amount * decimals))

    if (tokenUpper === 'SUI') {
      const [splitCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountBase)])
      tx.transferObjects([splitCoin], recipient)
    } else {
      // Non-SUI: resolve concrete coin objects so the PTB serializes for the browser.
      const r = await addTokenTransfers(tx, coinType, tokenUpper, senderAddress, [{ amountBase, recipient }])
      if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return }
    }

    const ptbJson = tx.serialize()
    res.json({ ok: true, ptbJson, token: tokenUpper, amount, recipient })
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

// POST /api/echo/:wallet/rules — parse + add a rule
app.post('/api/echo/:wallet/rules', requireWalletSigOrZkLogin(), async (req, res) => {
  try {
    const { raw, autoExecute } = req.body as { raw: string; autoExecute?: boolean }
    if (!raw?.trim()) { res.status(400).json({ ok: false, error: 'Rule text required' }); return }

    const { isRule, parsed, interpretation } = await parseRule(raw.trim())
    if (!isRule || !parsed) {
      res.json({ ok: false, notARule: true, interpretation }); return
    }

    const rule: EchoRule = {
      id:          crypto.randomUUID(),
      raw:         raw.trim(),
      parsed,
      active:      true,
      autoExecute: Boolean(autoExecute),
      createdAt:   Date.now(),
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
app.delete('/api/echo/:wallet/rules/:id', requireWalletSigOrZkLogin(), async (req, res) => {
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
app.post('/api/echo/:wallet/score', requireWalletSigOrZkLogin(), async (req, res) => {
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
app.post('/api/echo/:wallet/session-key', requireWalletSigOrZkLogin(), async (req, res) => {
  try {
    const { packageId, expiryDays = 7, maxPerTx, maxPerDay } = req.body as {
      packageId: string
      expiryDays?: number
      maxPerTx?: string
      maxPerDay?: string
    }
    if (!packageId) { res.status(400).json({ ok: false, error: 'packageId required' }); return }

    const keypair    = generateSessionKeypair()
    const sessionAddr = keypair.getPublicKey().toSuiAddress()
    const limits = {
      maxPerTx:  maxPerTx  ? BigInt(maxPerTx)  : DEFAULT_LIMITS.maxPerTx,
      maxPerDay: maxPerDay ? BigInt(maxPerDay) : DEFAULT_LIMITS.maxPerDay,
    }
    const expiresAt  = Date.now() + expiryDays * 24 * 60 * 60 * 1000

    // Store private key on Walrus. getSecretKey() returns Uint8Array on most
    // versions; older builds returned a base64 string — handle both.
    const secretKey: unknown = keypair.getSecretKey()
    const secretBytes = secretKey instanceof Uint8Array
      ? secretKey
      : Buffer.from(secretKey as string, 'base64')
    await storeSessionKey(req.params.wallet, secretBytes)

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
app.post('/api/echo/:wallet/session-key/confirm', requireWalletSigOrZkLogin(), async (req, res) => {
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
app.delete('/api/echo/:wallet/session-key', requireWalletSigOrZkLogin(), async (req, res) => {
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

/* ─── Internal worker endpoints (X-Echo-Worker-Secret only) ──────────── */

const requireWorkerSecret: express.RequestHandler<any> = (req, res, next) => {
  const secret = process.env.ECHO_WORKER_SECRET
  const provided = req.header('x-echo-worker-secret')
  if (!secret) { res.status(503).json({ ok: false, error: 'ECHO_WORKER_SECRET not configured' }); return }
  if (provided !== secret) { res.status(401).json({ ok: false, error: 'unauthorized' }); return }
  next()
}

app.get('/api/internal/health-factor/:wallet', requireWorkerSecret, async (req, res) => {
  try {
    const hf = await getHealthFactor(req.params.wallet)
    res.json({ ok: true, healthFactor: hf })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/internal/portfolio/:wallet', requireWorkerSecret, async (req, res) => {
  try {
    const snap = await fetchPortfolio(req.params.wallet)
    res.json({
      ok: true,
      totalUsd: snap.totalUsd,
      tokens: snap.balances.map(b => ({
        symbol:   b.symbol,
        amount:   Number(b.formatted),
        usdValue: b.usdValue,
      })),
      healthFactor: snap.navi?.healthFactor ?? null,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

// POST /api/echo/:wallet/execute — server-side autonomous swap using session key.
// Auth: wallet signature OR X-Echo-Worker-Secret. Reuses the tryAutoExecute pattern.
app.post('/api/echo/:wallet/execute', requireWalletSigOrWorkerSecret(), async (req, res) => {
  try {
    const wallet = req.params.wallet
    const { from, to, amount } = req.body as {
      from?:   string
      to?:     string
      amount?: number   // human-readable units (e.g. 100 USDC)
    }
    if (!from || !to || amount == null) {
      res.status(400).json({ ok: false, error: 'from, to, amount required' }); return
    }

    const fromToken = from.toUpperCase()
    const toToken   = to.toUpperCase()

    const { loadSessionKeypair } = await import('./echo/session.js')
    const keypair = await loadSessionKeypair(wallet)
    if (!keypair) {
      res.status(400).json({ ok: false, error: 'No session key found for wallet' }); return
    }

    const data = await readEchoData(wallet)
    const meta = data.sessionKeyMetadata
    if (!meta) {
      res.status(400).json({ ok: false, error: 'No session-key metadata recorded' }); return
    }
    if (meta.expiresAt < Date.now()) {
      res.status(400).json({ ok: false, error: 'Session key expired' }); return
    }

    const sessionAddr = keypair.getPublicKey().toSuiAddress()

    const amountIn = toBaseUnits(amount, fromToken)
    const routex   = await createRoutex('mainnet', sessionAddr)
    const quote    = await Promise.race([
      routex.getQuote({
        from:              fromToken,
        to:                toToken,
        amount:            amountIn,
        slippageTolerance: 0.005,
        senderAddress:     sessionAddr,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Quote timed out')), QUOTE_MS)
      ),
    ])

    // ── Append on-chain record_execution to the SAME PTB (Task 4) ──
    // The swap PTB lives in quote.ptb; we append a moveCall before executing
    // so the session limits are enforced atomically with the swap.
    const tx = quote.ptb as InstanceType<typeof import('@mysten/sui/transactions').Transaction>
    const pkgId = process.env.ECHO_REGISTRY_PACKAGE_ID
    if (!pkgId) {
      res.status(500).json({
        ok:    false,
        error: 'ECHO_REGISTRY_PACKAGE_ID not configured — cannot enforce on-chain limits',
      }); return
    }
    // Convert to USD-equivalent USDC micros (6 decimals) so the on-chain
    // limit check compares apples to apples regardless of from-token.
    const STABLE = new Set(['USDC', 'USDT', 'BUCK'])
    let usdMicros: bigint
    if (STABLE.has(fromToken)) {
      usdMicros = amountIn
    } else {
      const px = getCurrentPrice(fromToken)
      if (px == null || !isFinite(px) || px <= 0) {
        res.status(503).json({
          ok:    false,
          error: `Cannot derive USD-equivalent for ${fromToken} (no price feed) — refusing to skip on-chain limit check`,
        }); return
      }
      usdMicros = BigInt(Math.round(amount * px * 1_000_000))
    }

    tx.moveCall({
      target:    `${pkgId}::session_auth::record_execution`,
      arguments: [
        tx.object(meta.authObjectId),
        tx.pure.u64(usdMicros),
        tx.object('0x6'),
      ],
    })

    const sdkClient: any = await import('@mysten/sui/client')
    const suiClient = new sdkClient.SuiClient({ url: sdkClient.getFullnodeUrl('mainnet') })

    const result = await suiClient.signAndExecuteTransaction({
      signer:      keypair,
      transaction: tx,
      options:     { showEffects: true },
    })

    res.json({
      ok:     true,
      digest: result.digest,
      from:   fromToken,
      to:     toToken,
      amount,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

// POST /api/echo/:wallet/parse-rule — parse only, don't save (for preview)
app.post('/api/echo/:wallet/parse-rule', requireWalletSigOrZkLogin(), async (req, res) => {
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

/* ─── Cron tick — drives Echo watches & schedules in serverless ──────────
   Vercel has no long-running process, so setInterval/node-cron never run there.
   An external scheduler (cron-job.org, GitHub Actions, or a Vercel Cron) should
   hit this once a minute. Auth: CRON_SECRET via `x-cron-secret` header or
   `?secret=`. One pass = evaluate price conditions + fire due schedules. */

app.all('/api/cron/tick', async (req, res) => {
  const secret = process.env.CRON_SECRET
  if (!secret) { res.status(503).json({ ok: false, error: 'CRON_SECRET not configured' }); return }
  const provided =
    req.header('x-cron-secret') ??
    (req.header('authorization')?.replace(/^Bearer\s+/i, '')) ??
    (req.query.secret as string | undefined)
  if (provided !== secret) { res.status(401).json({ ok: false, error: 'unauthorized' }); return }

  try {
    const [conditions, schedules] = await Promise.all([
      runConditionTick().catch(e => ({ error: String(e?.message ?? e) })),
      runScheduleTick().catch(e => ({ error: String(e?.message ?? e) })),
    ])
    res.json({ ok: true, conditions, schedules, at: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

/* ─── Health ─────────────────────────────────────────────────────────── */

app.get('/api/health', (_, res) => {
  res.json({ ok: true, version: '2.1.0', features: ['guardian', 'navi', 'dca', 'conditions', 'memory', 'alerts', 'contacts', 'voice', 'echo'] })
})

/* ─── Start (skip in serverless environments) ─────────────────────────── */

export default app

if (!process.env.VERCEL) {
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
}
