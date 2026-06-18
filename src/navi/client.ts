/**
 * NAVI Protocol integration.
 * Provides health factor, pool rates, and PTB building for deposit/borrow/repay/withdraw.
 * PTBs are returned serialized for the UI to sign via dapp-kit.
 */

import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from '@mysten/sui/jsonRpc'
import { Transaction }               from '@mysten/sui/transactions'
import {
  NAVISDKClient,
  getAddressPortfolio,
  getHealthFactorCall,
  depositCoin,
  borrowCoin,
  repayDebt,
  pool as naviPool,
} from 'navi-sdk'

// Use the correct SuiClient from @mysten/sui/client — not the low-level jsonRpc variant.
const suiClient = new SuiClient({ url: getFullnodeUrl('mainnet'), network: 'mainnet' })

/* ─── Pool registry (PoolConfig, not CoinInfo — has poolId + assetId) ───── */
// depositCoin / borrowCoin / repayDebt need a PoolConfig, not a CoinInfo.

const POOL_CONFIG: Record<string, any> = {
  SUI:  naviPool.Sui,
  USDC: naviPool.nUSDC,  // native USDC (Circle) — preferred over wormhole wUSDC
  USDT: naviPool.USDT,
}

const COIN_DECIMALS: Record<string, number> = {
  SUI: 1e9, USDC: 1e6, USDT: 1e6,
}

/* ─── Health factor ─────────────────────────────────────────────────────── */

export async function getHealthFactor(wallet: string): Promise<number | null> {
  try {
    const hf = await getHealthFactorCall(wallet, suiClient as any)
    return typeof hf === 'number' ? hf : null
  } catch {
    return null
  }
}

/* ─── Portfolio positions ───────────────────────────────────────────────── */

export interface NaviPosition {
  symbol:        string
  supplyBalance: number
  borrowBalance: number
}

export async function getNaviPositions(wallet: string): Promise<NaviPosition[]> {
  const portfolio = await getAddressPortfolio(wallet, false, suiClient as any)
  const positions: NaviPosition[] = []
  for (const [symbol, data] of portfolio) {
    if (data.supplyBalance > 0 || data.borrowBalance > 0) {
      positions.push({ symbol, supplyBalance: data.supplyBalance, borrowBalance: data.borrowBalance })
    }
  }
  return positions
}

/* ─── Pool info ─────────────────────────────────────────────────────────── */

export async function getPoolRates(symbol: string) {
  try {
    const sdkClient = new NAVISDKClient({ networkType: 'mainnet', numberOfAccounts: 0 })
    const poolCfg   = POOL_CONFIG[symbol.toUpperCase()]
    if (!poolCfg) return null
    return await sdkClient.getPoolInfo(poolCfg)
  } catch {
    return null
  }
}

/* ─── Minimum deposit / borrow amounts ──────────────────────────────────── */

const NAVI_MIN: Record<string, number> = {
  SUI:  0.001,
  USDC: 0.01,
  USDT: 0.01,
}

function checkMinAmount(action: string, symbol: string, amount: number) {
  const min = NAVI_MIN[symbol.toUpperCase()] ?? 0.001
  if (amount < min) {
    throw new Error(
      `Amount too small for NAVI ${action}. Minimum is ${min} ${symbol.toUpperCase()} ` +
      `(you entered ${amount} ${symbol.toUpperCase()}).`
    )
  }
}

/* ─── PTB builders ──────────────────────────────────────────────────────── */

/** Build a deposit (supply) PTB. Returns serialized tx bytes as base64. */
export async function buildDepositPTB(
  wallet:  string,
  symbol:  string,
  amount:  number,
): Promise<string> {
  const pool = POOL_CONFIG[symbol.toUpperCase()]
  if (!pool) throw new Error(`Unsupported NAVI token: ${symbol}`)
  checkMinAmount('deposit', symbol, amount)

  const decimals  = COIN_DECIMALS[symbol.toUpperCase()] ?? 1e9
  const amountRaw = Math.round(amount * decimals)

  const tx = new Transaction()
  tx.setSender(wallet)
  const [coinObj] = tx.splitCoins(tx.gas, [amountRaw])
  await depositCoin(tx as any, pool, coinObj, amountRaw)

  tx.setGasBudget(20_000_000)
  const bytes = await tx.build({ client: suiClient as any })
  return Buffer.from(bytes).toString('base64')
}

/** Build a borrow PTB. Returns serialized tx bytes as base64. */
export async function buildBorrowPTB(
  wallet:  string,
  symbol:  string,
  amount:  number,
): Promise<string> {
  const pool = POOL_CONFIG[symbol.toUpperCase()]
  if (!pool) throw new Error(`Unsupported NAVI token: ${symbol}`)
  checkMinAmount('borrow', symbol, amount)

  const decimals  = COIN_DECIMALS[symbol.toUpperCase()] ?? 1e9
  const amountRaw = Math.round(amount * decimals)

  const tx = new Transaction()
  tx.setSender(wallet)
  await borrowCoin(tx as any, pool, amountRaw)

  tx.setGasBudget(20_000_000)
  const bytes = await tx.build({ client: suiClient as any })
  return Buffer.from(bytes).toString('base64')
}

/** Build a repay PTB. Returns serialized tx bytes as base64. */
export async function buildRepayPTB(
  wallet:  string,
  symbol:  string,
  amount:  number,
): Promise<string> {
  const pool = POOL_CONFIG[symbol.toUpperCase()]
  if (!pool) throw new Error(`Unsupported NAVI token: ${symbol}`)
  checkMinAmount('repay', symbol, amount)

  const decimals  = COIN_DECIMALS[symbol.toUpperCase()] ?? 1e9
  const amountRaw = Math.round(amount * decimals)

  const tx = new Transaction()
  tx.setSender(wallet)
  const [coinObj] = tx.splitCoins(tx.gas, [amountRaw])
  await repayDebt(tx as any, pool, coinObj, amountRaw)

  tx.setGasBudget(20_000_000)
  const bytes = await tx.build({ client: suiClient as any })
  return Buffer.from(bytes).toString('base64')
}
