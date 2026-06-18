/* ─── Echo TypeScript types ────────────────────────────────────────────── */

export interface EchoRule {
  id:           string
  raw:          string               // plain English as user typed
  parsed: {
    type:       'health_factor' | 'balance_floor' | 'stop_loss' | 'rebalance' | 'yield_optimization' | 'custom'
    asset?:     string
    threshold?: number
    action?:    string
    params?:    Record<string, unknown>
  }
  active:       boolean
  /** When true: executor runs the rule autonomously within session-key limits.
   *  When false: a one-tap proposal is pushed and the user confirms manually. */
  autoExecute:  boolean
  createdAt:    number
  lastTriggered?: number
}

export interface ScheduledIntent {
  id:                  string
  raw:                 string
  frequency:           'daily' | 'weekly' | 'monthly' | 'once'
  nextExecution:       number
  executionsRemaining: number
  totalExecuted:       number
  active:              boolean
  createdAt:           number
}

export interface WatchCondition {
  id:           string
  raw:          string
  asset:        string
  currentPrice: number
  triggerPrice: number
  direction:    'above' | 'below'
  intent:       string
  active:       boolean
  createdAt:    number
}

export interface MonitoredPosition {
  id:            string
  token:         string
  entryPrice:    number
  currentPrice:  number
  amount:        number
  stopLoss?:     number
  profitTarget?: number
  openedAt:      number
}

export interface EchoActivity {
  id:              string
  timestamp:       number
  description:     string
  action:          'alert' | 'proposal' | 'executed' | 'blocked'
  guardianScore?:  number
  digest?:         string
  valueProtected?: number
}

export interface EchoScore {
  total:           number   // 0-100
  diversification: number   // 0-25
  yieldEfficiency: number   // 0-25
  debtHealth:      number   // 0-25
  riskExposure:    number   // 0-25
  lastCalculated:  number
}

export interface SessionKeyMetadata {
  publicKey:       string   // session keypair's Sui address
  authObjectId:    string   // on-chain SessionAuthorization object ID
  expiresAt:       number   // epoch ms
  maxAmountPerTx:  number   // MIST
  maxAmountPerDay: number   // MIST
}

export interface EchoUserData {
  rules:             EchoRule[]
  scheduledIntents:  ScheduledIntent[]
  conditions:        WatchCondition[]
  positions:         MonitoredPosition[]
  activityLog:       EchoActivity[]
  echoScore:         EchoScore
  sessionKeyMetadata?: SessionKeyMetadata
  lastUpdated:       number
}

export const EMPTY_ECHO_DATA: EchoUserData = {
  rules:            [],
  scheduledIntents: [],
  conditions:       [],
  positions:        [],
  activityLog:      [],
  echoScore: {
    total: 0, diversification: 0, yieldEfficiency: 0,
    debtHealth: 0, riskExposure: 0, lastCalculated: 0,
  },
  lastUpdated: 0,
}

/* ─── Proposal (from medium/high mode) ───────────────────────────────── */

export interface EchoProposal {
  id:          string
  description: string
  ptbB64?:     string       // base64-encoded PTB ready to sign
  estimatedUsd?: number
  expiresAt:   number       // epoch ms (10 min from creation)
  reason:      string
}

/* ─── Wire types for worker → frontend push ───────────────────────────── */

export interface EchoAlertMessage {
  type:      'echo_alert'
  message:   string
  timestamp: number
}

export interface EchoProposalMessage {
  type:      'echo_proposal'
  proposal:  EchoProposal
  expiresAt: number
  timestamp: number
}

export interface EchoExecutedMessage {
  type:           'echo_executed'
  description:    string
  digest:         string
  valueUsd?:      number
  timestamp:      number
}

export type EchoWsMessage = EchoAlertMessage | EchoProposalMessage | EchoExecutedMessage
