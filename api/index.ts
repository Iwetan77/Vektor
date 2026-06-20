// Vercel serverless entrypoint.
// Uses a cached dynamic import so server.ts loads as ESM (package.json "type":"module"),
// which allows all @mysten/sui subpath imports to resolve correctly via ESM semantics.
import type { IncomingMessage, ServerResponse } from 'http'

let _app: ((req: IncomingMessage, res: ServerResponse) => void) | null = null

async function getApp() {
  if (!_app) {
    const mod = await import('../src/server.js')
    _app = mod.default as (req: IncomingMessage, res: ServerResponse) => void
  }
  return _app
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp()
  app(req, res)
}
