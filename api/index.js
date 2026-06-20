// Placeholder committed so Vercel's `functions` config validates on a fresh git
// clone. The real serverless bundle is produced by `npm run build:api` (tsup,
// see tsup.api.config.ts) during the Vercel build and overwrites this file.
// If you are seeing this response in production, the build step did not run.
export default function handler(_req, res) {
  res.statusCode = 500
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: 'Server bundle not built. Run `npm run build:api`.' }))
}
export const maxDuration = 30
