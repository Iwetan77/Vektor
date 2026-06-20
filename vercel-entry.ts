// Build entry for the Vercel serverless function.
//
// This file is bundled by tsup (tsup.api.config.ts) into a single self-contained
// ESM file at api/index.js, which Vercel serves as the API function. Bundling is
// required because Vercel's runtime crashes (ERR_REQUIRE_ESM) when CommonJS deps
// internally require() an ESM-only module (@mysten/sui, rpc-websockets -> uuid).
// Inlining every dependency removes all runtime require() of node_modules.
import './src/env-sanitize.js' // MUST be first: cleans BOM/whitespace from env before anything reads it
import type { IncomingMessage, ServerResponse } from 'http'
import app from './src/server.js'

export default function handler(req: IncomingMessage, res: ServerResponse) {
  ;(app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
}
