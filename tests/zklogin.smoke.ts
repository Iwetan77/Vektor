/**
 * zkLogin rail smoke test.
 *
 *   1. GET /api/zklogin/epoch       → { epoch: <number> }
 *   2. GET /api/zklogin/me (no cookie) → { signedIn: false }
 *
 * Boots a stripped Express app that only mounts the zkLogin routes — we don't
 * want this test to require the full server stack (Anthropic, Walrus, …).
 */

import 'dotenv/config'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import { registerZkLoginRoutes } from '../src/auth/zklogin-routes.js'

async function get(server: http.Server, path: string): Promise<{ status: number; body: any }> {
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  const url  = `http://127.0.0.1:${addr.port}${path}`
  const r    = await fetch(url, { redirect: 'manual' })
  const text = await r.text()
  let body: any = text
  try { body = JSON.parse(text) } catch {}
  return { status: r.status, body }
}

async function main() {
  const app = express()
  app.use(express.json())
  registerZkLoginRoutes(app)

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })

  try {
    // 1. /epoch returns a numeric epoch
    const epoch = await get(server, '/api/zklogin/epoch')
    assert.equal(epoch.status, 200, `/epoch expected 200, got ${epoch.status}: ${JSON.stringify(epoch.body)}`)
    assert.equal(typeof epoch.body.epoch, 'number', `/epoch should return number, got ${typeof epoch.body.epoch}`)
    assert.ok(epoch.body.epoch > 0, `epoch should be > 0, got ${epoch.body.epoch}`)
    console.log(`  /epoch          OK  (epoch=${epoch.body.epoch})`)

    // 2. /me without a cookie returns signedIn:false
    const me = await get(server, '/api/zklogin/me')
    assert.equal(me.status, 200, `/me expected 200, got ${me.status}`)
    assert.equal(me.body.signedIn, false, `/me should return signedIn:false, got ${JSON.stringify(me.body)}`)
    console.log(`  /me (no cookie) OK  (signedIn=false)`)

    console.log('\nzklogin smoke  GREEN')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

main().catch((e) => { console.error('zklogin smoke  RED:', e.message); process.exit(1) })
