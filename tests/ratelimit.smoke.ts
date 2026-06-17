/**
 * Rate-limit smoke — boots a minimal Express app with the same limiter the
 * server applies to /api/intent (10 requests per minute per IP), fires 12
 * rapid requests, and asserts at least one returns 429.
 */

import express from 'express'
import rateLimit from 'express-rate-limit'

const PORT = 4001

async function main() {
  const app = express()
  app.use(express.json())

  const intentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      10,
    standardHeaders: true,
    legacyHeaders:   false,
    message:  { ok: false, error: 'rate limit exceeded' },
  })
  app.use('/api/intent', intentLimiter)
  app.post('/api/intent', (_req, res) => res.json({ ok: true }))

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(PORT, () => resolve(s))
  })

  let saw429 = false
  try {
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/intent`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ text: 'ping' }),
      })
      statuses.push(r.status)
      if (r.status === 429) saw429 = true
    }
    console.log('statuses:', statuses.join(','))
    console.log(`429-observed → ${saw429 ? 'PASS' : 'FAIL'}`)
  } finally {
    server.close()
  }

  if (!saw429) process.exit(1)
  console.log('RATELIMIT SMOKE OK')
}

main().catch(err => { console.error(err); process.exit(1) })
