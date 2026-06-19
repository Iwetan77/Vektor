import Routex from 'routex-sui'
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { parseIntent } from './intent/parser.js'
import { Guardian } from './guardian/index.js'
import { PTBCompiler } from './compiler/ptb-compiler.js'
import { ConfirmationGate } from './gate/confirmation-gate.js'
import { VektorLogClient } from './log/vektorlog-client.js'
import type {
  ParseIntentParams,
  VektorIntent,
  GuardianReport,
  GateDecision,
  VektorResult,
} from './types.js'

export interface VektorOptions {
  network?: 'mainnet' | 'testnet'
  senderAddress: string
  /** Auto-confirm all swaps without CLI prompt. Default false. */
  autoConfirm?: boolean
  /** VektorLog package ID. If omitted, on-chain logging is disabled. */
  vektorLogPackageId?: string
}

/**
 * Vektor — intent engine for Sui.
 *
 * Wraps Routex with intent parsing, Guardian risk assessment, CLI confirmation,
 * and on-chain logging via the VektorLog Move contract.
 *
 * Typical flow:
 *
 *   const vektor = new Vektor({ network: 'mainnet', senderAddress: '0x...' })
 *
 *   const report  = await vektor.guard({ action: 'swap', from: 'SUI', to: 'USDC', amount: '1' })
 *   const gate    = await vektor.confirm(report)
 *   if (gate.proceed) {
 *     const result = await vektor.execute(gate, signer)
 *   }
 *
 * Or all-in-one:
 *
 *   const result = await vektor.swap({ action: 'swap', from: 'SUI', to: 'USDC', amount: '1' }, signer)
 */
export class Vektor {
  private readonly network:   'mainnet' | 'testnet'
  private readonly sender:    string
  private readonly compiler:  PTBCompiler
  private readonly guardian:  Guardian
  private readonly gate:      ConfirmationGate
  private readonly vektorLog: VektorLogClient
  private readonly suiClient: SuiJsonRpcClient

  constructor(options: VektorOptions) {
    this.network   = options.network ?? 'mainnet'
    this.sender    = options.senderAddress
    this.suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(this.network) } as any)
    this.compiler  = new PTBCompiler(this.network, this.sender)
    this.guardian  = new Guardian({ suiClient: this.suiClient, senderAddress: this.sender })
    this.gate      = new ConfirmationGate(options.autoConfirm ?? false)
    this.vektorLog = new VektorLogClient(this.network, options.vektorLogPackageId)
  }

  // ─── Step 1: Parse ──────────────────────────────────────────────────────────

  parse(params: ParseIntentParams): VektorIntent {
    return parseIntent(params)
  }

  // ─── Step 2: Guard ──────────────────────────────────────────────────────────

  async guard(params: ParseIntentParams): Promise<GuardianReport> {
    const intent = this.parse(params)
    const { quote } = await this.compiler.compile(intent)
    return this.guardian.evaluate(intent, quote)
  }

  // ─── Step 3: Confirm ────────────────────────────────────────────────────────

  async confirm(report: GuardianReport): Promise<GateDecision> {
    return this.gate.evaluate(report)
  }

  // ─── Step 4: Execute ────────────────────────────────────────────────────────

  async execute(gate: GateDecision, signer: any): Promise<VektorResult> {
    if (!gate.proceed) {
      throw new Error('Cannot execute: Confirmation Gate did not approve this intent.')
    }

    const { intent, quote } = gate.report
    const ptb = quote.ptb

    // Append VektorLog call to the same PTB (atomic — logs only if swap succeeds)
    const protocol = quote.route.map(s => s.protocol).join('+')
    this.vektorLog.appendLog(ptb, {
      intentId:  intent.id,
      protocol,
      amountIn:  intent.amountIn,
      amountOut: quote.amountOut,
    })

    // Execute via Routex executor
    const routex = new Routex(this.network, this.sender)
    const txResult = await (routex as any).executor.execute(ptb, signer)

    const logEntry = this.vektorLog.buildEntry(
      intent.id,
      protocol,
      intent.amountIn,
      quote.amountOut,
      txResult.digest,
    )

    return {
      digest:    txResult.digest,
      intentId:  intent.id,
      amountOut: quote.amountOut,
      logEntry,
    }
  }

  // ─── All-in-one: swap ───────────────────────────────────────────────────────

  /**
   * Convenience method: parse → guard → confirm → execute in one call.
   *
   * Throws if Guardian blocks the trade. In non-autoConfirm mode, prompts
   * for CLI confirmation before executing.
   */
  async swap(params: ParseIntentParams, signer: any): Promise<VektorResult> {
    const report = await this.guard(params)
    const gate   = await this.confirm(report)

    if (!gate.proceed) {
      throw new Error(
        gate.report.blocked
          ? 'Swap blocked by Guardian. Check the risk report for details.'
          : 'Swap cancelled by user.',
      )
    }

    return this.execute(gate, signer)
  }

  // ─── Expose sub-components for advanced use ─────────────────────────────────

  get guardianEngine(): Guardian        { return this.guardian  }
  get logClient(): VektorLogClient      { return this.vektorLog }
}

// Named exports for type-only consumers
export type {
  ParseIntentParams,
  VektorIntent,
  GuardianReport,
  GateDecision,
  VektorResult,
} from './types.js'
export { RiskClass } from './types.js'
export type { RiskFlag, LogEntry, ZkLoginSession } from './types.js'

// zkLogin: see src/auth/zklogin-core/* for the new server rail and src/ui/useZkLogin.ts for the client hook.

export default Vektor
