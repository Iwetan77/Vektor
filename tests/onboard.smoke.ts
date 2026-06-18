/**
 * /onboard fast-path smoke — checks amount parsing.
 *
 * Posts to a real running server (via /api/intent) and verifies:
 *   1. "/onboard mum with $5" → inviteLink present, stored invite.amount === 5
 *   2. "/onboard dad"         → amount defaults to 1
 *
 * Requires the dev server on http://localhost:3001.
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { getInviteLink } from '../src/db/store.js'

const BASE = process.env.VEKTOR_BASE_URL ?? 'http://localhost:3001'

async function call(text: string, sender: string) {
  const res = await fetch(`${BASE}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, senderAddress: sender }),
  })
  return res.json() as Promise<{
    ok: boolean
    inviteLink?: string | null
    amount?: number
    recipient?: string | null
    error?: string
  }>
}

function tokenFromLink(link: string): string {
  const u = new URL(link)
  return u.searchParams.get('invite') ?? ''
}

async function main() {
  const sender = new Ed25519Keypair().getPublicKey().toSuiAddress()

  // Case 1: "/onboard mum with $5"
  const r1 = await call('/onboard mum with $5', sender)
  console.log('case1 response:', JSON.stringify({ ok: r1.ok, link: !!r1.inviteLink, amount: r1.amount, recipient: r1.recipient }))
  const link1 = r1.inviteLink
  if (!r1.ok || !link1) { console.error('FAIL: no inviteLink'); process.exit(1) }
  const tok1 = tokenFromLink(link1)
  const stored1 = getInviteLink(tok1)
  console.log('stored1:', JSON.stringify({ token: stored1?.token?.slice(0,8), amount: stored1?.amount, symbol: stored1?.token_symbol }))
  const ok1 = stored1?.amount === 5
  console.log(ok1 ? 'case1 PASS (amount=5)' : `case1 FAIL (amount=${stored1?.amount})`)

  // Case 2: "/onboard dad" → default $1
  const r2 = await call('/onboard dad', sender)
  console.log('case2 response:', JSON.stringify({ ok: r2.ok, link: !!r2.inviteLink, amount: r2.amount, recipient: r2.recipient }))
  const link2 = r2.inviteLink
  if (!r2.ok || !link2) { console.error('FAIL: no inviteLink'); process.exit(1) }
  const tok2 = tokenFromLink(link2)
  const stored2 = getInviteLink(tok2)
  console.log('stored2:', JSON.stringify({ token: stored2?.token?.slice(0,8), amount: stored2?.amount }))
  const ok2 = stored2?.amount === 1
  console.log(ok2 ? 'case2 PASS (amount=1)' : `case2 FAIL (amount=${stored2?.amount})`)

  if (!ok1 || !ok2) { console.error('ONBOARD SMOKE FAILED'); process.exit(1) }
  console.log('ONBOARD SMOKE OK')
}

main().catch(err => { console.error(err); process.exit(1) })
