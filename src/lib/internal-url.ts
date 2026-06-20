/**
 * Base URL the server uses to call its OWN endpoints (e.g. a cron tick invoking
 * /api/echo/:wallet/execute). On localhost the API listens on PORT; on Vercel
 * there is no local listener, so self-calls must go to the public deployment URL.
 */
export function internalBaseUrl(): string {
  const strip = (u: string) => u.replace(/\/+$/, '')
  if (process.env.VEKTOR_INTERNAL_URL) return strip(process.env.VEKTOR_INTERNAL_URL)
  if (process.env.VEKTOR_URL)          return strip(process.env.VEKTOR_URL)
  if (process.env.VERCEL_URL)          return `https://${process.env.VERCEL_URL}`
  return `http://127.0.0.1:${process.env.PORT ?? '3001'}`
}
