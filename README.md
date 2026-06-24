# Vektor

**Financial OS for Sui.** Swap, lend, send, and automate — in plain English. Sign in with Google. No seed phrase.

Live: [vektor-sui.vercel.app](https://vektor-sui.vercel.app)

---

## What it does

Vektor is a chat-first interface for the Sui blockchain. You type what you want in plain English — or any of 25 supported languages — and Vektor parses your intent, runs a risk assessment, previews the transaction, and executes it with one tap.

```
"swap 10 USDC for SUI"
"lend 100 USDC on NAVI"
"send 5 SUI to adeniyi.sui"
"DCA $50 into SUI every week for 30 days"
"sell my SUI if price drops below $2"
"pay rent: 30 USDC each to Alice, Bob, Charlie"
```

Authentication is via zkLogin — your Google account generates a Sui wallet. No private key to manage, no seed phrase to lose.

---

## Features

### Core intents
- **Swap** — multi-DEX routing via Routex (Cetus, Turbos, Aftermath, DeepBook, Bluefin, FlowX)
- **Lend / Borrow / Repay** — NAVI Protocol integration with live rates and health factor monitoring
- **Send** — native SUI and any token; resolves SuiNS names (e.g. `adeniyi.sui`)
- **Batch & split payment** — pay multiple recipients in one transaction
- **Contact payments** — save wallet addresses as names (`add Alice = 0x…`), pay by name

### Automation
- **DCA** — dollar-cost average into any asset on a daily / weekly / monthly schedule
- **Scheduled swaps** — one-time swaps at a future date
- **Conditional orders** — trigger actions when price crosses a threshold or health factor drops

> **Operational note — the autonomous layer.** Conditional orders, scheduled
> swaps/DCA, and Echo act *while you are offline*. On a serverless deployment this
> behaviour is provided by three runtime services, configured through environment
> rather than bundled in code:
>
> 1. **Durable state** — a Redis/KV store (`UPSTASH_REDIS_REST_URL` /
>    `UPSTASH_REDIS_REST_TOKEN`). Serverless filesystems are ephemeral and per
>    instance; without KV, schedules and conditions do not persist or coordinate
>    across invocations.
> 2. **A scheduler** — a cron calling `/api/cron/tick` (declared in `vercel.json`,
>    authenticated by `CRON_SECRET`). This is what evaluates price triggers and
>    fires due schedules; per-minute cadence requires a Vercel Pro plan or an
>    external cron service.
> 3. **Execution authority** — a deployed `session_auth` package plus an Echo
>    session key (`VEKTOR_KEY_ENCRYPTION_SECRET`, `ECHO_WORKER_SECRET`), enabling
>    execution within on-chain spend caps.
>
> Interactive intents — swap, lend, borrow, send, batch payment — execute
> immediately at sign time and depend on none of the above. The autonomous layer
> activates once these services are provisioned for the target deployment.

### Intelligence
- **Guardian risk system** — every transaction is scored across 7 risk classes before you sign. Blocks dangerous trades; warns on high price impact, loose slippage, thin liquidity, large size
- **Advice log** — Guardian recommendations from past swaps surface in the Advice tab
- **Portfolio analysis** — `analyse my wallet` breaks down holdings and on-chain activity
- **Transaction explainer** — `explain tx 5kT…abc` returns plain-English summaries of any Sui transaction
- **Per-wallet memory** — Vektor remembers your preferences, past intents, and alerts across sessions

### Echo — autonomous agent
Echo gives Vektor the ability to act while you're offline. It uses session keys stored on Walrus and enforced by an on-chain `SessionAuthorization` object with configurable spend caps.

- Create a session key → sign the on-chain authorization with your main wallet
- Write rules in plain English: `never let my health factor drop below 1.5`, `exit any memecoin down 25%`
- Toggle `autoExecute` per rule: off sends you a one-tap alert, on executes inside the on-chain limits
- Revoke any time — closes the session authorization and the encrypted key on Walrus

### Other
- **Voice input** — speak your intent; transcribed and parsed in real time
- **Multilingual** — 25 languages; African language DeFi terms stay in English by convention
- **Onboarding** — `/onboard a friend with 0.001 SUI` generates a shareable invite link; the new user receives funds on sign-in
- **History tab** — full intent log with success / pending / failed status
- **SuiNS resolution** — addresses and `.sui` names resolve in both directions

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18 · Vite · Tailwind CSS |
| Backend | Express 5 · Node.js · TypeScript |
| AI parser | Groq `llama-3.3-70b` (default) · Anthropic Claude · Gemini |
| Blockchain | Sui mainnet via `@mysten/sui` |
| DEX routing | Routex SDK |
| Lending | NAVI Protocol SDK |
| Auth | zkLogin — Google OAuth → Sui address (no private key) |
| Decentralised storage | Walrus (Echo session keys) |
| Deployment | Vercel (frontend + serverless API) |

---

## Architecture

```
User message
     │
     ▼
parseIntent()          — LLM extracts intent type, tokens, amounts, recipients
     │
     ▼
validateIntent()       — sanity-checks token symbols, amounts, addresses
     │
     ▼
Guardian v2            — 7 risk classes evaluated in parallel
     │
     ▼
ConfirmationGate       — renders risk summary + PermissionCard for user review
     │
     ▼
PTB compiled           — Routex quote (swap) / NAVI SDK (lend/borrow) / SUI transfer
     │
     ▼
User signs             — zkLogin ephemeral key signs the PTB client-side
     │
     ▼
Executed on-chain      — digest returned, receipt card rendered, history updated
```

---

## Running locally

### Prerequisites

- Node.js 20+
- A Groq API key (free at [console.groq.com](https://console.groq.com)) — or an Anthropic / Gemini key
- A Google OAuth 2.0 client ID and secret

### Setup

```bash
git clone https://github.com/iwetan77/Vektor.git
cd Vektor
npm install
cp .env.example .env
```

Edit `.env`:

```env
# AI provider — set exactly one
GROQ_API_KEY=gsk_...
# ANTHROPIC_API_KEY=sk-ant-...
# GEMINI_API_KEY=...

# Sui network
SUI_NETWORK=mainnet

# Google OAuth (for zkLogin)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3001/api/zklogin/callback

# Session encryption
SESSION_SECRET=<random 32-char string>
```

### Start

```bash
# Terminal 1 — API server (port 3001)
npm run dev:server

# Terminal 2 — Vite dev server (port 5173)
npm run dev:ui
```

Open [http://localhost:5173](http://localhost:5173).

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | One of three | Groq API key (llama-3.3-70b) |
| `ANTHROPIC_API_KEY` | One of three | Anthropic API key (Claude) |
| `GEMINI_API_KEY` | One of three | Google Gemini API key |
| `SUI_NETWORK` | Yes | `mainnet` or `testnet` |
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 client ID for zkLogin |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | Yes | OAuth callback URL |
| `SESSION_SECRET` | Yes | Express session encryption key |
| `VEKTOR_FUNDING_KEY` | Optional | Sui private key for onboarding faucet |
| `SUI_PRIVATE_KEY` | Optional | Walrus storage signer; also server-side key for scheduled auto-execution |
| `UPSTASH_REDIS_REST_URL` | Autonomy | Durable KV endpoint for schedules/conditions (also accepts `KV_REST_API_URL`) |
| `UPSTASH_REDIS_REST_TOKEN` | Autonomy | Durable KV token (also accepts `KV_REST_API_TOKEN`) |
| `CRON_SECRET` | Autonomy | Authenticates calls to `/api/cron/tick` |
| `VEKTOR_KEY_ENCRYPTION_SECRET` | Autonomy | AES-256 key (base64, 32 bytes) for Echo session-key encryption |
| `ECHO_WORKER_SECRET` | Autonomy | Authorises the scheduler to invoke Echo session-key execution |
| `ECHO_REGISTRY_PACKAGE_ID` | Autonomy | Deployed `session_auth` package ID (server) |
| `VITE_ECHO_PACKAGE_ID` | Autonomy | Deployed `session_auth` package ID (UI) |
| `SMOKE_TEST_KEY` | Optional | Bypasses rate limits in integration tests |

"Autonomy" variables are required only for the offline automation layer (see the
operational note under [Features → Automation](#automation)); interactive intents
do not need them.

---

## Deploying to Vercel

```bash
npm install -g vercel
vercel login
vercel deploy --prod
```

Set all environment variables in the Vercel dashboard or via CLI:

```bash
echo "your-groq-key" | vercel env add GROQ_API_KEY production
```

The `GOOGLE_REDIRECT_URI` must be updated to your Vercel domain and added as an authorised redirect URI in Google Cloud Console.

---

## Guardian — risk classes

Every transaction is evaluated before the user can sign.

| Class | Trigger | Severity |
|---|---|---|
| `HIGH_PRICE_IMPACT` | Impact exceeds threshold | Block |
| `LOOSE_SLIPPAGE` | Slippage warn >5%, block >20% | Warn / Block |
| `STALE_QUOTE` | Quote TTL < 5 s remaining | Warn |
| `THIN_LIQUIDITY` | Price impact >1% (shallow pool) | Warn |
| `INSUFFICIENT_GAS` | SUI balance < trade + 2× gas estimate | Block |
| `PROTOCOL_CONCENTRATION` | 100% routed through a single non-DeepBook AMM | Warn |
| `LARGE_TRADE` | Trade size >$5,000 equivalent | Warn |

A single `Block`-severity flag prevents execution. `Warn` flags require the user to acknowledge before proceeding.

---

## Echo session key security model

1. Vektor generates an ephemeral Ed25519 keypair in the browser
2. The private key is encrypted with AES-256-GCM (`VEKTOR_KEY_ENCRYPTION_SECRET`) and stored on Walrus
3. The user signs an on-chain `SessionAuthorization` object with their main wallet — this sets `maxPerTx`, `maxPerDay`, and `expiresAt` enforced by the Move contract
4. The session key can sign swaps autonomously up to those caps; anything exceeding them reverts on-chain
5. Revoking from the Echo panel calls `session_auth::revoke` — the authorization is closed and the Walrus blob is effectively dead

---

## Project structure

```
src/
  server.ts          — Express API (all routes)
  parser/            — LLM intent parser + validator
  guardian/          — Risk assessment (7 classes)
  compiler/          — PTB builder
  navi/              — NAVI Protocol client
  echo/              — Session keys, rules, scoring
  scheduler/         — Cron-based DCA + scheduled swaps
  conditions/        — Price trigger monitor (Pyth)
  alerts/            — Health factor + position monitor
  memory/            — Per-wallet JSON memory store
  db/                — Scheduled intents, contacts, positions
  contacts/          — Contact book + group management
  payments/          — Payment request links
  portfolio/         — Sui RPC fetcher + transaction explainer
  walrus/            — Walrus decentralised storage client
  suins/             — SuiNS name resolution
  ai/                — AI provider abstraction (Groq / Anthropic / Gemini)
  ui/                — React frontend
    App.tsx          — Main shell, chat, signing flows
    LandingPage.tsx  — Public landing page
    EchoPage.tsx     — Echo autonomous agent UI
    Sidebar.tsx      — Portfolio, history, scheduled, watch, advice tabs
    cards/           — SwapQuoteCard, TransactionReceiptCard, BundleReceiptCard, PermissionCard
```

---

## License

MIT — see [LICENSE](LICENSE)
