/**
 * Echo executor — gates execution per RULE via rule.autoExecute.
 *   autoExecute:true  → call backend /api/echo/:wallet/execute (session key signs).
 *   autoExecute:false → pushProposal for one-tap user confirm.
 */

import { pushExecuted, pushProposal } from './alerter'
import type { EchoUser, Env, EchoRule } from './types'
import type { State }  from './evaluator'

interface ExecuteParams {
  from:   string
  to:     string
  amount: number
}

async function callBackendExecute(
  user:   EchoUser,
  params: ExecuteParams,
  env:    Env,
): Promise<string /* digest */> {
  const baseUrl = (env as Env & { VEKTOR_BACKEND_URL?: string }).VEKTOR_BACKEND_URL
    ?? 'http://localhost:3001'
  const secret  = (env as Env & { ECHO_WORKER_SECRET?: string }).ECHO_WORKER_SECRET ?? ''

  const res = await fetch(`${baseUrl}/api/echo/${user.address}/execute`, {
    method: 'POST',
    headers: {
      'content-type':          'application/json',
      'x-echo-worker-secret':  secret,
    },
    body: JSON.stringify(params),
  })

  const body = await res.json() as { ok: boolean; digest?: string; error?: string }
  if (!body.ok || !body.digest) {
    throw new Error(`backend execute failed: ${body.error ?? res.status}`)
  }
  return body.digest
}

export async function executeWithSessionKey(opts: {
  user:   EchoUser
  ptbB64: string
  env:    Env
  description: string
  estimatedUsd?: number
  params?: ExecuteParams
}): Promise<string /* digest */> {
  const { user, env, description, estimatedUsd, params } = opts
  const meta = user.echoData.sessionKeyMetadata
  if (!meta) throw new Error('No session key metadata')
  if (meta.expiresAt < Date.now()) throw new Error('Session key expired')
  if (!params) throw new Error('execute params (from/to/amount) required')

  const digest = await callBackendExecute(user, params, env)
  await pushExecuted(user.address, description, digest, estimatedUsd, env).catch(() => {})
  return digest
}

/** Execute or propose a rule. Gated by rule.autoExecute. */
export async function executeRule(
  rule:  EchoRule,
  user:  EchoUser,
  _state: State,
  env:   Env,
): Promise<void> {
  const description = rule.parsed.action ?? rule.raw
  const params = paramsFromRule(rule)

  if (!rule.autoExecute) {
    await pushProposal(user.address, {
      id:          rule.id,
      description,
      reason:      `Rule "${rule.raw}" triggered — confirm to execute`,
      expiresAt:   Date.now() + 600_000,
    }, env).catch(() => {})
    return
  }

  if (!params) {
    await pushExecuted(user.address, `${description} (no params)`, '', undefined, env).catch(() => {})
    return
  }
  try {
    const digest = await callBackendExecute(user, params, env)
    await pushExecuted(user.address, description, digest, undefined, env).catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await pushExecuted(user.address, `${description} (failed: ${msg})`, '', undefined, env).catch(() => {})
  }
}

/** Execute a scheduled intent that is due. */
export async function executeScheduledIntent(
  user:     EchoUser,
  intentId: string,
  env:      Env,
): Promise<void> {
  const intent = user.echoData.scheduledIntents.find(s => s.id === intentId)
  if (!intent || !intent.active) return

  const params = paramsFromScheduled(intent)
  if (!params) {
    await pushExecuted(user.address, `Scheduled: ${intent.raw}`, '', undefined, env).catch(() => {})
    return
  }
  try {
    const digest = await callBackendExecute(user, params, env)
    await pushExecuted(user.address, `Scheduled: ${intent.raw}`, digest, undefined, env).catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await pushExecuted(user.address, `Scheduled failed: ${msg}`, '', undefined, env).catch(() => {})
  }
}

function paramsFromRule(rule: EchoRule): ExecuteParams | null {
  const p = rule.parsed.params as Record<string, unknown> | undefined
  if (!p) return null
  const from   = typeof p.from === 'string' ? p.from : undefined
  const to     = typeof p.to   === 'string' ? p.to   : undefined
  const amount = typeof p.amount === 'number' ? p.amount : undefined
  if (!from || !to || amount == null) return null
  return { from, to, amount }
}

function paramsFromScheduled(intent: { raw: string } & Record<string, unknown>): ExecuteParams | null {
  const from   = typeof intent.from === 'string'   ? intent.from   : undefined
  const to     = typeof intent.to === 'string'     ? intent.to     : undefined
  const amount = typeof intent.amount === 'number' ? intent.amount : undefined
  if (!from || !to || amount == null) return null
  return { from, to, amount }
}
