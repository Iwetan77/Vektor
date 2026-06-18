/**
 * EchoHub — Cloudflare Durable Object that maintains WebSocket connections.
 * One instance per user, identified by their wallet address.
 *
 * Frontend connects to: GET /ws/:userAddress
 * Worker pushes to:     POST /push/:userAddress  { payload: string }
 */

export class EchoHub {
  private state:   DurableObjectState
  private sockets: Set<WebSocket> = new Set()

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade from frontend
    if (url.pathname.startsWith('/ws')) {
      const upgrade = request.headers.get('Upgrade')
      if (upgrade !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 })
      }
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.state.acceptWebSocket(server)
      this.sockets.add(server)

      server.addEventListener('close', () => this.sockets.delete(server))
      server.addEventListener('error', () => this.sockets.delete(server))

      return new Response(null, { status: 101, webSocket: client })
    }

    // Internal push from monitor loop
    if (url.pathname.startsWith('/push') && request.method === 'POST') {
      const { payload } = await request.json() as { payload: string }
      let delivered = 0
      for (const ws of this.sockets) {
        try {
          ws.send(payload)
          delivered++
        } catch {
          this.sockets.delete(ws)
        }
      }
      return Response.json({ ok: true, delivered })
    }

    return new Response('Not found', { status: 404 })
  }

  // Durable Object alarm / hibernation websocket handlers
  webSocketMessage() {}
  webSocketClose(ws: WebSocket) { this.sockets.delete(ws) }
  webSocketError(ws: WebSocket) { this.sockets.delete(ws) }
}

import type { Env } from './types'

/** Push a message to a user's active WebSocket connections */
export async function pushToUser(
  userAddress: string,
  message:     unknown,
  env:         Env,
): Promise<void> {
  const id  = env.ECHO_HUB.idFromName(userAddress)
  const hub = env.ECHO_HUB.get(id)
  await hub.fetch('http://internal/push/' + userAddress, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ payload: JSON.stringify(message) }),
  })
}

export async function pushAlert(
  userAddress: string,
  message:     string,
  env:         Env,
): Promise<void> {
  await pushToUser(userAddress, { type: 'echo_alert', message, timestamp: Date.now() }, env)
}

export async function pushProposal(
  userAddress: string,
  proposal:    unknown,
  env:         Env,
): Promise<void> {
  await pushToUser(userAddress, {
    type:      'echo_proposal',
    proposal,
    expiresAt: Date.now() + 600_000,
    timestamp: Date.now(),
  }, env)
}

export async function pushExecuted(
  userAddress:  string,
  description:  string,
  digest:       string,
  valueUsd:     number | undefined,
  env:          Env,
): Promise<void> {
  await pushToUser(userAddress, {
    type:        'echo_executed',
    description,
    digest,
    valueUsd,
    timestamp:   Date.now(),
  }, env)
}
