/**
 * Auth smoke — boots a minimal Express app that mounts requireWalletSig
 * on a guarded route, then asserts:
 *   1. NO signature  → 401
 *   2. VALID sig     → not 401
 *
 * Self-contained: does not import src/server.ts (which has heavyweight side
 * effects like starting cron jobs and binding port 3001).
 */

import express from 'express'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { requireWalletSig } from '../src/middleware/requireWalletSig.js'

const PORT = 3999

async function main() {
  const app = express()
  app.use(express.json())
  app.post('/api/echo/:wallet/mode', requireWalletSig(), (_req, res) => {
    res.json({ ok: true })
  })

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(PORT, () => resolve(s))
  })

  let pass1 = false
  let pass2 = false

  try {
    const kp = new Ed25519Keypair()
    const addr = kp.getPublicKey().toSuiAddress()

    // 1) no signature → 401
    const r1 = await fetch(`http://127.0.0.1:${PORT}/api/echo/${addr}/mode`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ mode: 'basic' }),
    })
    pass1 = r1.status === 401
    console.log(`no-sig request → status=${r1.status} ${pass1 ? 'PASS' : 'FAIL'}`)

    // 2) valid signature → not 401
    const ts = Date.now()
    const message = new TextEncoder().encode(`vektor-auth:${addr}:${ts}`)
    const { signature } = await kp.signPersonalMessage(message)

    const r2 = await fetch(`http://127.0.0.1:${PORT}/api/echo/${addr}/mode`, {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-vektor-sig':       signature,
        'x-vektor-timestamp': String(ts),
      },
      body: JSON.stringify({ mode: 'basic' }),
    })
    pass2 = r2.status !== 401
    console.log(`valid-sig request → status=${r2.status} ${pass2 ? 'PASS' : 'FAIL'}`)
  } finally {
    server.close()
  }

  if (!pass1 || !pass2) {
    console.error('AUTH SMOKE FAILED')
    process.exit(1)
  }
  console.log('AUTH SMOKE OK')
}

main().catch(err => { console.error(err); process.exit(1) })
