/**
 * Strips UTF-8 BOM (﻿) and surrounding whitespace from every environment
 * variable value.
 *
 * Some shells (notably PowerShell pipes) prepend a BOM when adding Vercel env
 * vars, producing values like "﻿mainnet". That breaks exact-match lookups
 * such as getFullnodeUrl('mainnet') and any value sent verbatim to an external
 * API (Google OAuth client id/secret, etc.).
 *
 * This module mutates process.env and MUST be imported before any other module
 * that reads process.env (i.e. first import in the serverless entrypoint).
 */
for (const key of Object.keys(process.env)) {
  const val = process.env[key]
  if (typeof val === 'string') {
    const cleaned = val.replace(/﻿/g, '').trim()
    if (cleaned !== val) process.env[key] = cleaned
  }
}

export {}
