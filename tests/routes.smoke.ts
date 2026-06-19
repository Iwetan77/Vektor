/**
 * routes.smoke — exercises every STRUCTURED server route against a live
 * server on :3001. These routes take structured JSON (not free text), so they
 * do NOT call the Groq parser — safe to run as a batch with zero rate-limit
 * risk. The free-text /api/intent path (which does hit Groq) is covered
 * separately and sparingly by tests/features.smoke.ts.
 *
 * Includes deliberate "human mistake" inputs:
 *   • send to a token symbol instead of an address   → must reject
 *   • send to an unregistered .sui name              → must reject
 *   • negative / zero amounts                        → must reject
 *   • missing required fields                        → must reject
 *
 * Run:  ./node_modules/.bin/tsx tests/routes.smoke.ts
 */

import { webcrypto } from 'node:crypto'
// @noble (used by Ed25519Keypair) needs a global WebCrypto in some node builds.
if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'

const BASE = process.env.VEKTOR_BASE ?? 'http://127.0.0.1:3001'

// A syntactically valid mainnet address used as sender/recipient for PTB
// builds (PTB construction does not touch the chain, so any 0x… works).
const ADDR = '0xa11ce00000000000000000000000000000000000000000000000000000000001'

type Check = { name: string; pass: boolean; detail: string; soft?: boolean }
const results: Check[] = []

function record(name: string, pass: boolean, detail = '', soft = false) {
  results.push({ name, pass, detail, soft })
  const tag = pass ? 'PASS' : soft ? 'WARN' : 'FAIL'
  console.log(`  ${tag.padEnd(4)}  ${name.padEnd(46)} ${detail}`)
}

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: any = null
  const txt = await r.text()
  try { json = txt ? JSON.parse(txt) : null } catch { json = { _raw: txt } }
  return { status: r.status, json }
}

/** Signed headers for requireWalletSig-guarded routes. */
async function signedHeaders(kp: Ed25519Keypair, address: string) {
  const ts = Date.now()
  const msg = new TextEncoder().encode(`vektor-auth:${address}:${ts}`)
  const { signature } = await kp.signPersonalMessage(msg)
  return { 'x-vektor-sig': signature, 'x-vektor-timestamp': String(ts) }
}

async function main() {
  console.log(`\nROUTES SMOKE — ${BASE}`)
  console.log('='.repeat(94))

  /* ── Health / read-only ─────────────────────────────────────────── */
  console.log('\n── Health & read-only ──')
  {
    const { status, json } = await req('GET', '/api/health')
    record('GET /api/health', status === 200 && json?.ok === true, `v${json?.version}`)
  }
  {
    const { json } = await req('GET', '/api/prices')
    const hasSui = json && (json.SUI || json.prices?.SUI || json.sui || json.data?.SUI)
    record('GET /api/prices returns SUI price', !!hasSui, hasSui ? `SUI≈${JSON.stringify(hasSui).slice(0, 12)}` : JSON.stringify(json).slice(0, 60), true)
  }
  {
    const { status, json } = await req('GET', '/api/stats')
    record('GET /api/stats', status === 200 && json?.ok === true)
  }
  {
    const { status, json } = await req('GET', '/api/walrus/health')
    record('GET /api/walrus/health', status === 200 && typeof json?.ok === 'boolean', `ok=${json?.ok}`, true)
  }

  /* ── Portfolio ──────────────────────────────────────────────────── */
  console.log('\n── Portfolio ──')
  {
    const { status, json } = await req('POST', '/api/portfolio', {})
    record('POST /api/portfolio missing wallet → 400', status === 400, `status=${status}`)
  }
  {
    const { status, json } = await req('POST', '/api/portfolio', { wallet: ADDR })
    record('POST /api/portfolio valid wallet → ok', status === 200 && json?.ok === true && !!json?.portfolio, `balances=${json?.portfolio?.balances?.length ?? '?'}`, true)
  }

  /* ── Send PTB (human-mistake battery) ───────────────────────────── */
  console.log('\n── Send PTB ──')
  {
    const { status, json } = await req('POST', '/api/send-ptb', { senderAddress: ADDR, recipient: ADDR, token: 'SUI', amount: 0.01 })
    record('send-ptb valid SUI→0x → ok ptbJson', status === 200 && json?.ok === true && !!json?.ptbJson)
  }
  {
    const { status, json } = await req('POST', '/api/send-ptb', { senderAddress: ADDR, recipient: 'USDC', token: 'SUI', amount: 0.01 })
    record('send-ptb recipient="USDC" → reject', status === 400 && json?.ok === false, json?.error?.slice(0, 50))
  }
  {
    const { status, json } = await req('POST', '/api/send-ptb', { senderAddress: ADDR, recipient: 'zzzznotreal9999.sui', token: 'SUI', amount: 0.01 })
    record('send-ptb unregistered .sui → reject', status === 400 && json?.ok === false, json?.error?.slice(0, 50))
  }
  {
    const { status, json } = await req('POST', '/api/send-ptb', { senderAddress: ADDR, recipient: ADDR, token: 'SUI', amount: -5 })
    record('send-ptb negative amount → reject', status === 400 && json?.ok === false, `status=${status}`)
  }
  {
    // Unfunded test address: the FIX means a clean rejection ("don't hold any
    // USDC" / "Insufficient"), NOT the old 500 "Unknown transaction $Intent".
    const { status, json } = await req('POST', '/api/send-ptb', { senderAddress: ADDR, recipient: ADDR, token: 'USDC', amount: 1 })
    const err = String(json?.error ?? '')
    const noIntentCrash = status !== 500 && !/\$Intent/.test(err)
    const cleanReject   = status === 400 && /hold any|Insufficient/i.test(err)
    const happy         = status === 200 && json?.ok === true && !!json?.ptbJson
    record('send-ptb USDC no $Intent crash', noIntentCrash && (cleanReject || happy), err.slice(0, 50))
  }
  {
    // Mechanism proof: a fully-concrete non-SUI transfer (object refs, no
    // coinWithBalance intent) MUST serialize and round-trip through
    // Transaction.from — this is exactly what addTokenTransfers produces.
    let serOk = false, detail = ''
    try {
      const tx = new Transaction()
      tx.setSender(ADDR)
      const fakeCoin = tx.object('0xbeef000000000000000000000000000000000000000000000000000000000001')
      const [out] = tx.splitCoins(fakeCoin, [tx.pure.u64(1000000n)])
      tx.transferObjects([out], ADDR)
      const j = tx.serialize()
      Transaction.from(j)
      serOk = j.length > 0
    } catch (e: any) { detail = e.message?.slice(0, 50) ?? String(e) }
    record('concrete token PTB serializes + round-trips', serOk, detail)
  }

  /* ── Batch payment PTB ──────────────────────────────────────────── */
  console.log('\n── Batch payment PTB ──')
  {
    const members = [{ name: 'a', address: ADDR }, { name: 'b', address: ADDR }]
    const { status, json } = await req('POST', '/api/batch-payment-ptb', { senderAddress: ADDR, members, amountPerPerson: 0.01, token: 'SUI' })
    record('batch-ptb 2 members SUI → ok', status === 200 && json?.ok === true && json?.recipientCount === 2)
  }
  {
    const { status, json } = await req('POST', '/api/batch-payment-ptb', { senderAddress: ADDR, amountPerPerson: 1, token: 'SUI' })
    record('batch-ptb missing members → reject', status === 400 && json?.ok === false)
  }

  /* ── NAVI PTB ───────────────────────────────────────────────────── */
  console.log('\n── NAVI PTB ──')
  {
    const { status, json } = await req('POST', '/api/navi-ptb', { sender: ADDR, type: 'frobnicate', token: 'SUI', amount: 1 })
    record('navi-ptb bad type → reject', status === 400 && json?.ok === false)
  }
  {
    const { status, json } = await req('POST', '/api/navi-ptb', { sender: ADDR, token: 'SUI' })
    record('navi-ptb missing fields → reject', status === 400 && json?.ok === false)
  }
  {
    const { status, json } = await req('POST', '/api/navi-ptb', { sender: ADDR, type: 'lend', token: 'SUI', amount: 1 })
    record('navi-ptb lend build (external) → ok', status === 200 && json?.ok === true && !!json?.ptbB64, json?.ok ? '' : (json?.error ?? '').slice(0, 50), true)
  }

  /* ── Swap PTB / quote (external Routex) ─────────────────────────── */
  console.log('\n── Swap PTB (Routex) ──')
  {
    const { status, json } = await req('POST', '/api/ptb', { sender: ADDR })
    record('ptb missing fields → reject', status === 400 && json?.ok === false)
  }
  {
    const { status, json } = await req('POST', '/api/ptb', { from: 'SUI', to: 'USDC', amountIn: '1000000000', slippage: 0.005, sender: ADDR })
    record('ptb SUI→USDC build (external) → ok', status === 200 && json?.ok === true && !!json?.ptbJson, json?.ok ? '' : (json?.error ?? '').slice(0, 50), true)
  }

  /* ── Scheduler / conditions CRUD ────────────────────────────────── */
  console.log('\n── Scheduler & conditions ──')
  {
    const { status, json } = await req('GET', `/api/schedule/${ADDR}`)
    record('GET /api/schedule/:wallet → ok array', status === 200 && json?.ok === true && Array.isArray(json?.scheduled))
  }
  {
    const { status, json } = await req('GET', `/api/conditions/${ADDR}`)
    record('GET /api/conditions/:wallet → ok array', status === 200 && json?.ok === true && Array.isArray(json?.conditions))
  }
  {
    // Delete with no signature on a guarded route → must 401
    const { status } = await req('DELETE', '/api/schedule/nonexistent-id')
    record('DELETE /api/schedule/:id unsigned → 401', status === 401, `status=${status}`)
  }

  /* ── Onboarding ─────────────────────────────────────────────────── */
  console.log('\n── Onboarding ──')
  {
    const { status, json } = await req('POST', '/api/onboard/link', {})
    record('onboard/link missing creator → 400', status === 400 && json?.ok === false)
  }
  {
    const { status, json } = await req('POST', '/api/onboard/link', { creatorWallet: ADDR })
    record('onboard/link valid → ok link', status === 200 && json?.ok === true && !!json?.link)
    if (json?.invite?.token) {
      const r2 = await req('GET', `/api/onboard/${json.invite.token}`)
      record('onboard/:token resolve → ok', r2.status === 200 && r2.json?.ok === true)
    }
  }
  {
    const { status } = await req('GET', '/api/onboard/totally-bogus-token')
    record('onboard/:badtoken → 404', status === 404)
  }

  /* ── Memory / alerts / echo (read) ──────────────────────────────── */
  console.log('\n── Memory / alerts / echo ──')
  {
    const { status, json } = await req('GET', `/api/memory/${ADDR}`)
    record('GET /api/memory/:wallet → ok', status === 200 && json?.ok === true, '', true)
  }
  {
    const { status, json } = await req('GET', `/api/alerts/${ADDR}`)
    record('GET /api/alerts/:wallet → ok', status === 200 && json?.ok === true, '', true)
  }
  {
    const { status, json } = await req('GET', `/api/echo/${ADDR}`)
    record('GET /api/echo/:wallet → ok', status === 200 && json?.ok === true, '', true)
  }

  /* ── Contacts CRUD (signed, real keypair) ───────────────────────── */
  console.log('\n── Contacts CRUD (signed) ──')
  {
    const kp = new Ed25519Keypair()
    const wallet = kp.getPublicKey().toSuiAddress()

    // Unsigned add → 401
    const unsigned = await req('POST', `/api/contacts/${wallet}`, { name: 'Mum', address: ADDR })
    record('contacts add unsigned → 401', unsigned.status === 401, `status=${unsigned.status}`)

    // Signed add → ok
    const h1 = await signedHeaders(kp, wallet)
    const add = await req('POST', `/api/contacts/${wallet}`, { name: 'Mum', address: ADDR }, h1)
    record('contacts add signed → ok', add.status === 200 && add.json?.ok === true, `status=${add.status} ${(add.json?.error ?? '').slice(0,40)}`)

    // List reflects it
    const list = await req('GET', `/api/contacts/${wallet}`)
    const hasMum = Array.isArray(list.json?.contacts) && list.json.contacts.some((c: any) => c.name === 'Mum')
    record('contacts list shows new contact', list.status === 200 && hasMum, `count=${list.json?.contacts?.length ?? '?'}`)

    // Delete signed → ok
    const h2 = await signedHeaders(kp, wallet)
    const del = await req('DELETE', `/api/contacts/${wallet}/Mum`, undefined, h2)
    record('contacts delete signed → ok', del.status === 200 && del.json?.ok !== false, `status=${del.status}`)
  }

  /* ── Simulate guard ─────────────────────────────────────────────── */
  console.log('\n── Guardian simulate ──')
  {
    const { status, json } = await req('POST', '/api/simulate', {})
    record('simulate missing txDigest → 400', status === 400 && json?.ok === false)
  }

  /* ── Summary ────────────────────────────────────────────────────── */
  console.log('\n' + '='.repeat(94))
  const hard = results.filter(r => !r.soft)
  const hardFail = hard.filter(r => !r.pass)
  const softFail = results.filter(r => r.soft && !r.pass)
  const pass = results.filter(r => r.pass).length
  console.log(`TOTAL: ${pass}/${results.length} pass · ${hardFail.length} hard-fail · ${softFail.length} soft-warn`)
  if (softFail.length) {
    console.log('\nSOFT WARNINGS (external deps — verify manually if relevant):')
    softFail.forEach(r => console.log(`  · ${r.name} — ${r.detail}`))
  }
  if (hardFail.length) {
    console.log('\nHARD FAILURES:')
    hardFail.forEach(r => console.log(`  ✗ ${r.name} — ${r.detail}`))
    process.exit(1)
  }
  console.log('\nROUTES SMOKE OK (all hard checks pass)')
}

main().catch(err => { console.error(err); process.exit(1) })
