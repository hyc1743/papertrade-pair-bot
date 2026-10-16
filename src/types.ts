import type { Address, Hex } from 'viem';

export const WAD = 10n ** 18n;
export const CHAIN_ID = 999;
export const EXCHANGE = '0x6cd5661646289fb6e65ea5c032310fded797d0a2' as Address;
export const PAPER_STAKING = '0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016' as Address;
export const ORIGIN = 'https://exchange.papertrade.xyz';
export const RPC = 'https://rpc.hyperliquid.xyz/evm';
export const HL_WS = 'wss://api.hyperliquid.xyz/ws';
export const ZERO = '0x0000000000000000000000000000000000000000' as Address;
export type Side = 'A' | 'B';
export type Action = 'registerSessionKey' | 'openPosition' | 'closePositions' | 'paperStake' | 'paperClaim';
export type PrimaryType = 'RegisterSessionKey' | 'OpenPosition' | 'Close' | 'CancelIntent' | 'Stake' | 'Claim';
export type Signed = Record<string, string | boolean | string[]>;
export type Outcome = 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'unknown';
export type IntentState = 'prepared' | 'unknown' | 'queued' | Outcome;

export interface Position {
  id: string; instrumentId: number; isLong: boolean; useDebt: boolean;
  entry: bigint; margin: bigint; leverage: number; bust: bigint;
  openedAtMs: number; intentId: Hex | null;
}
export interface ClosedPosition {
  id: string; instrumentId: number; isLong: boolean; margin: bigint;
  leverage: number; liquidated: boolean; netPnl: bigint; paper: bigint;
  openIntentId?: Hex;
  closedAtMs?:number;
  openedAtMs?:number;
}
export interface Operation { id: Hex; action: string; deadline: bigint; positionIds: string[] }
export interface Wallet {
  address: Address; revision: number; block: number; timestamp: number; queueRevision: bigint;
  balance: bigint; queued: bigint; locked: bigint; available: bigint;
  sessions: Record<string, bigint>; paper: bigint; staked: bigint;
  claimedRewards: bigint;
  withdrawn: bigint;
  realizedPnl: bigint; positions: Position[]; operations: Operation[];
  closed: ClosedPosition[]; outcomes: { id: Hex; outcome: Outcome }[];
}
export interface Market {
  id: number; symbol: 'BTC' | 'ETH'; assetIndex: number; priceScale: bigint;
  active: boolean; paused: boolean; retired: boolean; closeOnly: boolean;
  frozenBid: bigint | null; frozenAsk: bigint | null;
  rateMultiplier: bigint; positionMultiplier: bigint; maxLeverage: number;
  maxNotional: bigint; bustBuffer: bigint; baseRate: bigint; referenceNotional: bigint;
  longOi: bigint; shortOi: bigint; longCap: bigint; shortCap: bigint;
}
export interface Trading {
  block: number; paused: boolean; minMargin: bigint; minNotional: bigint;
  markets: Market[]; disabledActions: string[]; maxNetOi: bigint;
  minPaperStake: bigint;
}
export interface Protocol {
  block: number; sourceAt: number; lpCash: bigint; queue: bigint;
  feesPending: bigint; feesLifetime: bigint;
  paper: { trackedLp: bigint; tail: bigint; cliff: bigint; cap: bigint; rate: bigint; decay: bigint; staked: bigint; pendingRewards: bigint };
}
export interface Quote { bid: bigint; ask: bigint; mid: bigint; time: number; receivedAt: number }
export interface Intent {
  id: Hex; wallet: Address; round: number | null; action: Action; signed: Signed;
  state: IntentState; deadline: number; createdAt: number; ackRevision: string | null;
}
export interface Leg {
  wallet: Address; openIntent: Hex; position: Position | null; closeIntent: Hex | null;
  settled: ClosedPosition | null;
}
export interface Round {
  id: number; state: 'opening' | 'hedged' | 'closing' | 'recovering' | 'complete';
  createdAt: number; reason: string | null; legs: [Leg, Leg];
  firstFillAt?: number;
  leadOpenIndex?: 0|1;
  manualRetargets?: { at: number; fromBps: number; toBps: number; protocolBlock: number; quoteMidRaw: string }[];
  strategy?: StrategyDecision;
}
export interface Receipt { intentId: Hex; action: Action; state: string; queueRevision: bigint }
export interface StrategyDecision {
  mode: 'fixed' | 'lpDynamic' | 'lpAccumulating'; phase: 'fixed' | 'activation' | 'fees' | 'surplus' | 'paused';
  canOpen: boolean; reasons: string[]; closeMoveBps: number; marginUsdc: string; leverage: number;
  notionalUsdc: string; expectedPaper: string; expectedNetLossUsdc: string; mintRate: string;
  lpCashUsdc: string; trackedLpUsdc: string; queuedUsdc: string; tailProgressUsdc: string;
  sourceAt: number; sourceBlock: number;
  autoLeverage?:boolean;
  /** null disables the BTC volatility estimated-hold candidate filter. */
  costModeMaxHoldMinutes?:number|null;
  costModeObjective?:'unitCost'|'throughput';
  closeEfficiency?:CloseEfficiencyMetrics;
  stakeTargetPaper?:string;
  conservativePaper?:string;
  plannedLossesPerWallet?:number;
  projectedPaperAfterRounds?:string;
  walletStakePlans?:WalletStakePlan[];
  costPerPaperUsdc?:string;
  estimatedHoldMinutes?:number|null;
  volatilityBpsPerSqrtMinute?:number|null;
  volatilitySamples?:number;
  horizonSatisfied?:boolean;
  walletSizing?:{wallet:string;tradeSpendableUsdc:string;marginBudgetUsdc:string;requiredLeverage:string|null}[];
}
export interface CloseOptimization {
  closeMoveBps:number;costPerPaperUsdc:string;estimatedHoldMinutes:number|null;
  volatilityBpsPerSqrtMinute:number|null;volatilitySamples:number;horizonSatisfied:boolean;
  closeEfficiency?:CloseEfficiencyMetrics;
}
export interface CloseEfficiencyMetrics {
  costToleranceBps:number;minimumCostPerPaperUsdc:string;costLimitPerPaperUsdc:string;
  projectedCostUsdc:string;projectedPaper:string;estimatedPaperPerHour:number;stakeAdjustedPaperPerHour:number;
  estimatedCycleMinutes:number;closeDelayMinutes:number;closeP90Minutes:number;openDelayMinutes:number;
  executionSamples:number;rateDeclinePerMinute:number;rateTrendSamples:number;
  effectiveSigmaBps:number;trendEfficiency:number;range15Bps:number|null;
  walletBatchPlans:{wallet:string;minimumPaper:string;availablePaper:string;shortfallPaper:string;
    estimatedLosingRounds:number;estimatedBatchMinutes:number}[];
}
export interface WalletStakePlan {
  wallet:string; alreadyStaked:boolean; availablePaper:string; stakedPaper:string;
  minimumPaper:string; targetPaper:string; shortfallToMinimumPaper:string; shortfallToTargetPaper:string;
  estimatedLossesToTarget:number|null; projectedPaperAfterPlannedLosses:string;
}
