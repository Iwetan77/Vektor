export interface EchoRule {
  id:           string
  raw:          string
  parsed: {
    type:       string
    asset?:     string
    threshold?: number
    action?:    string
    params?:    Record<string, unknown>
  }
  active:       boolean
  autoExecute:  boolean
  createdAt:    number
  lastTriggered?: number
}

export interface WatchCondition {
  id: string; raw: string; asset: string; currentPrice: number
  triggerPrice: number; direction: 'above' | 'below'; intent: string
  active: boolean; createdAt: number
}

export interface ScheduledIntent {
  id: string; raw: string; frequency: string; nextExecution: number
  executionsRemaining: number; totalExecuted: number; active: boolean; createdAt: number
}

export interface MonitoredPosition {
  id: string; token: string; entryPrice: number; currentPrice: number
  amount: number; stopLoss?: number; profitTarget?: number; openedAt: number
}

export interface EchoActivity {
  id: string; timestamp: number; description: string
  action: 'alert' | 'proposal' | 'executed' | 'blocked'
  guardianScore?: number; digest?: string; valueProtected?: number
}

export interface EchoScore {
  total: number; diversification: number; yieldEfficiency: number
  debtHealth: number; riskExposure: number; lastCalculated: number
}

export interface EchoUserData {
  rules: EchoRule[]
  scheduledIntents: ScheduledIntent[]
  conditions: WatchCondition[]
  positions: MonitoredPosition[]
  activityLog: EchoActivity[]
  echoScore: EchoScore
  sessionKeyMetadata?: {
    publicKey: string; authObjectId: string; expiresAt: number
    maxAmountPerTx: number; maxAmountPerDay: number
  }
  lastUpdated: number
}

export interface EchoUser {
  address:     string
  registryId:  string    // on-chain EchoRegistry object ID
  blobId:      string    // Walrus blob ID for EchoUserData
  echoData:    EchoUserData
  watchedAssets: string[]
}

export interface Env {
  ECHO_HUB:                 DurableObjectNamespace
  SUI_NETWORK:              string
  SUI_RPC_URL:              string
  SUI_PRIVATE_KEY:          string
  ECHO_REGISTRY_PACKAGE_ID: string
  ANTHROPIC_API_KEY?:       string
}
