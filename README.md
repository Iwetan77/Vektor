# Vektor

Intent engine for Sui. Vektor wraps [Routex](https://www.npmjs.com/package/routex-sui) with structured intent parsing, multi-class risk assessment, CLI confirmation, and optional on-chain execution logging via a Move contract.

## Architecture

```
ParseIntentParams
      │
      ▼
  parseIntent()          ← validates tokens, normalises amounts, assigns ID
      │
      ▼
  PTBCompiler            ← calls Routex for a live quote + pre-built PTB
      │                     [SEAL_V1.5 placeholder — encrypt before quote]
      ▼
  Guardian               ← 7 risk classes evaluated in parallel
      │
      ▼
  ConfirmationGate       ← auto-confirm or interactive CLI prompt
      │
      ▼
  execute()              ← submits PTB, appends VektorLog call atomically
      │
      ▼
  VektorResult           ← digest, intentId, amountOut, log entry
```

## Install

```bash
npm install vektor-sui
```

## Quick start

```typescript
import Vektor from 'vektor-sui'

const vektor = new Vektor({
  network: 'mainnet',
  senderAddress: '0x...',
  autoConfirm: false,           // set true to skip CLI prompt
})

// Step-by-step
const report = await vektor.guard({ action: 'swap', from: 'SUI', to: 'USDC', amount: '10' })
const gate   = await vektor.confirm(report)   // prints risk summary, prompts y/N

if (gate.proceed) {
  const result = await vektor.execute(gate, signer)
  console.log(result.digest)
}

// All-in-one
const result = await vektor.swap(
  { action: 'swap', from: 'SUI', to: 'USDC', amount: '10', slippage: 'low' },
  signer,
)
```

## Intent params

| Field | Type | Description |
|---|---|---|
| `action` | `'swap'` | Operation type |
| `from` | `string` | Input token symbol — `SUI`, `USDC`, `USDT`, `DEEP`, `WETH` |
| `to` | `string` | Output token symbol |
| `amount` | `string \| bigint` | Human amount (`'1.5'`) or raw base units (`1_500_000_000n`) |
| `slippage` | `'low' \| 'medium' \| 'high' \| number` | Tolerance preset or exact fraction. Defaults to `'medium'` (0.5%) |
| `maxPriceImpact` | `number` | Block threshold for price impact. Default `0.05` (5%) |
| `deadlineSeconds` | `number` | Intent TTL in seconds. Default `28` |

## Guardian — risk classes

The Guardian evaluates 7 risk classes and marks each as `block`, `warn`, or `info`. A single `block` prevents execution.

| Class | Trigger |
|---|---|
| `HIGH_PRICE_IMPACT` | Impact exceeds `maxPriceImpact` |
| `LOOSE_SLIPPAGE` | Slippage warn >5%, block >20% |
| `STALE_QUOTE` | Quote TTL < 5 s remaining |
| `THIN_LIQUIDITY` | Impact >1% (pool is shallow) |
| `INSUFFICIENT_GAS` | SUI balance < trade amount + 2× gas |
| `PROTOCOL_CONCENTRATION` | 100% routed through a single non-DeepBook AMM |
| `LARGE_TRADE` | Trade size >$5,000 USD equivalent |

```typescript
const report = await vektor.guard({ action: 'swap', from: 'SUI', to: 'USDC', amount: '1' })

report.blocked        // true if any risk is severity='block'
report.risks          // RiskFlag[]
report.quote          // live RoutexQuote
```

## zkLogin

Vektor ships optional zkLogin auth so users can sign transactions with a Google / Facebook / Twitch account — no private key required.

```typescript
import { ZkLoginAuth } from 'vektor-sui'

const auth = new ZkLoginAuth('mainnet', {
  clientId:    'YOUR_OAUTH_CLIENT_ID',
  redirectUri: 'https://yourapp.com/callback',
  provider:    'google',
})

// 1. Generate OAuth URL and redirect user
const { url } = await auth.generateLoginUrl()

// 2. After redirect, exchange JWT for a ZK session
const session = await auth.handleCallback(jwt, userSalt)

// session.address — use as senderAddress in VektorOptions
// 3. Sign PTBs
const signature = await auth.signTransaction(session, txBytes)
```

## VektorLog Move contract

The `vektorlog` Move contract emits an `IntentExecuted` event atomically within the same PTB as the swap — so the log only appears on-chain if the trade succeeds.

```
contracts/vektorlog/
  sources/vektorlog.move
  Move.toml
```

Deploy:

```bash
cd contracts/vektorlog
sui client publish --gas-budget 100000000
```

Pass the deployed package ID to `Vektor`:

```typescript
const vektor = new Vektor({
  network: 'mainnet',
  senderAddress: '0x...',
  vektorLogPackageId: '0x<PACKAGE_ID>',
})
```

## API

### `new Vektor(options)`

| Option | Type | Description |
|---|---|---|
| `network` | `'mainnet' \| 'testnet'` | Default `'mainnet'` |
| `senderAddress` | `string` | Sui wallet address |
| `autoConfirm` | `boolean` | Skip CLI confirmation prompt. Default `false` |
| `vektorLogPackageId` | `string` | Deployed VektorLog package. Omit to disable logging |

### `vektor.guard(params)` → `GuardianReport`

Parses the intent, fetches a live quote from Routex, and runs all 7 Guardian checks. Does not execute.

### `vektor.confirm(report)` → `GateDecision`

Prints a formatted risk summary. In interactive mode prompts `y/N`. In `autoConfirm` mode approves automatically unless a `block`-severity risk is present.

### `vektor.execute(gate, signer)` → `VektorResult`

Submits the PTB. If VektorLog is configured, appends the log call to the same PTB atomically.

### `vektor.swap(params, signer)` → `VektorResult`

Convenience method that runs guard → confirm → execute in one call.

## Environment variables

| Variable | Description |
|---|---|
| `VEKTORLOG_PACKAGE_ID` | Deployed VektorLog package ID (alternative to constructor option) |

## SEAL integration (v1.5)

The PTB compiler contains a clearly marked placeholder where [Seal SDK](https://github.com/MystenLabs/seal) encryption will slot in to prevent front-running:

```typescript
// SEAL_V1.5 — encrypt intent here using Seal SDK before submission
// to prevent front-running. See block comment above for integration notes.
```

## Testing Vektor

### Try these in the chat

Plain-English intents the chat parses and routes. Replace token amounts or addresses freely.

- **Swap** — `swap 10 USDC for SUI`
- **Swap (slippage preset)** — `swap 1 SUI to USDC with low slippage`
- **Multilingual** — `troca 5 USDC por SUI` · `换 5 USDC 为 SUI`
- **NAVI lend** — `deposit 5 SUI on NAVI`
- **NAVI borrow** — `borrow 20 USDC against my SUI on NAVI`
- **NAVI repay** — `repay 10 USDC on NAVI`
- **DCA schedule** — `DCA $50 into SUI every week`
- **One-shot scheduled swap** — `swap 100 USDC to SUI tomorrow at noon`
- **Conditional order** — `sell half my SUI if SUI drops below $2`
- **Conditional NAVI guard** — `repay my NAVI debt if health factor drops below 1.5`
- **Add a contact** — `add Alice = 0xabc…123`
- **Contact payment** — `send 5 USDC to Alice`
- **Group / batch payment** — `pay rent: 30 USDC each to Alice, Bob, Charlie`
- **Split payment** — `split 60 USDC three ways between Alice, Bob, Charlie`
- **Balance** — `check my balance` · `how much USDC do I have`
- **Price** — `what's the price of SUI`
- **Portfolio analysis** — `analyse my wallet`
- **Explain a transaction** — `explain tx 5kT…abc`

### Testing Echo (autonomous agent)

Echo is one mode. It always watches portfolio + health factor + price triggers and runs rules. Each rule has an `autoExecute` flag — `true` runs autonomously within session-key limits, `false` pushes a one-tap proposal you confirm. The worker polls every 60 seconds, so triggers fire within a minute.

1. Open Echo from the sidebar and connect your wallet.
2. **Create a session key** — Echo generates an ephemeral keypair, encrypts it with AES-256-GCM, stores it on Walrus, and returns an unsigned `SessionAuthorization` PTB.
3. **Sign the authorization with your main wallet.** This caps per-tx and per-day spend on-chain. Default limits: $10k/tx, $50k/day; pass `maxPerTx` / `maxPerDay` (USDC base units) when creating to override.
4. **Add a rule.** Examples:
   - `never let my health factor drop below 1.5`
   - `exit any memecoin down 25%`
   - `always keep 100 USDC liquid`
5. Toggle `autoExecute` on the rule. With it off: alerts + one-tap proposals. With it on: Echo executes via the session key inside the on-chain limits.
6. **Revoke** any time from the session-key panel — that closes the on-chain SessionAuthorization and the encrypted key on Walrus is no longer usable.

### Testing /onboard

The `/onboard` flow ships testnet USDC from a dedicated funding wallet to a brand-new user — they don't need to own SUI to receive it.

1. In the chat: `/onboard a friend with $5` (defaults to $1 if no amount given).
2. Copy the returned invite link.
3. Open the link in an incognito window.
4. Sign in with Google (zkLogin). The WelcomePage auto-claims as soon as it has your session address.
5. Watch for the `✓ Your $5 has arrived.` confirmation and the on-chain digest.

Funds come from `VEKTOR_FUNDING_KEY` (testnet only). The claim endpoint hard-enforces: USDC coin type only, exact `invite.amount` (capped at 50), only to the address passed in the request body, single use per invite, and rate-limited to 5/min/IP.

## License

MIT
