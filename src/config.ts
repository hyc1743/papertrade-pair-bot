import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { amount } from './util.js';
import { parseOpeningAt } from './schedule.js';

const money = z.string().refine(s => { try { return amount(s) > 0n; } catch { return false; } }, '必须填写正金额字符串');
const nonnegativeMoney = z.string().refine(s => { try { return amount(s) >= 0n; } catch { return false; } }, '必须填写非负金额字符串');
export const configSchema = z.object({
  market: z.enum(['BTC','ETH']).default('BTC'),
  marginUsdc: money, leverage: z.number().int().min(1).max(1000), maxNetLossUsdc: money.nullable().default(null),
  maxRounds: z.number().int().positive().nullable().default(null),
  closeMoveBps: z.number().int().min(5).max(500).default(100), bustHeadroomBps: z.number().int().min(20).max(1000).default(20),
  maxEntryGapBps: z.number().int().min(0).max(10).default(1),
  oiHeadroomUsdc: nonnegativeMoney.default('0'),
  oiStableSnapshots: z.number().int().min(1).max(20).default(1),
  oiStableMinMs: z.number().int().min(0).max(60000).default(0),
  oiAdmissionCooldownMs: z.number().int().min(1000).max(3600000).default(120000),
  openTimeoutMs: z.number().int().min(1000).max(300000).nullable().default(30000),
  hedgeTimeoutMs: z.number().int().min(1000).max(300000).default(30000),
  openIntentTtlSeconds: z.number().int().min(30).max(3600).default(3600),
  intentTtlSeconds: z.number().int().min(30).max(300).default(60),
  quoteMaxAgeMs: z.number().int().min(1000).max(5000).default(5000),
  hedgedDataGraceMs: z.number().int().min(0).max(60000).default(15000),
  pollIntervalMs: z.number().int().min(500).max(5000).default(1000),
  openingAtUtc: z.string().refine(s=>{try{parseOpeningAt(s);return true;}catch{return false;}},'必须是有效的带日期 UTC 时间（Z）').nullable().default(null),
  openingCheckLeadMs: z.number().int().min(0).max(60000).default(3000),
  stateDir: z.string().min(1).default('./data'),
  strategyMode: z.enum(['fixed','lpDynamic','lpAccumulating']).default('fixed'),
  stakeTargetBps: z.number().int().min(10000).max(20000).default(10500),
  accumulationMinBps: z.number().int().min(5).max(100).default(15),
  accumulationRounds: z.number().int().min(2).max(10).default(2),
  costEfficiencyToleranceBps: z.number().int().min(0).max(10000).default(2000),
  costModeMinBps: z.number().int().min(5).max(100).default(25),
  costModeMaxBps: z.number().int().min(25).max(250).default(100),
  costModeMaxHoldMinutes: z.number().int().min(30).max(4320).nullable().default(480),
  costModeWarmupBps: z.number().int().min(5).max(250).default(50),
  costModeObjective: z.enum(['unitCost','throughput']).default('unitCost'),
  throughputCostToleranceBps: z.number().int().min(0).max(10000).default(2500),
  throughputAgedToleranceBps: z.number().int().min(0).max(10000).default(3000),
  throughputAgeRampMinutes: z.number().int().min(30).max(1440).default(180),
  executionLookbackRounds: z.number().int().min(3).max(30).default(8),
  slowCloseAfterMs: z.number().int().min(30000).max(3600000).default(180000),
  slowCloseForceAfterMs: z.number().int().min(30000).max(7200000).default(300000),
  slowCloseFloorBps: z.number().int().min(5).max(25).default(10),
  slowCloseStepMs: z.number().int().min(30000).max(3600000).default(180000),
  slowCloseMaxLosses: z.number().int().min(2).max(10).default(6),
  lowVolatilityRangeBps: z.number().int().min(1).max(100).default(12),
  slowCloseCostToleranceBps: z.number().int().min(0).max(10000).default(5000),
  capitalPerWalletUsdc: money.nullable().default(null),
  autoLeverage: z.boolean().default(false),
  targetNotionalUsdc: money.nullable().default(null),
  minLeverage: z.number().int().min(1).max(1000).default(1),
  maxLeverage: z.number().int().min(1).max(1000).default(100),
  marginUtilizationBps: z.number().int().min(1).max(10000).default(6667),
  alternateDirections: z.boolean().default(false),
  lpPollIntervalMs: z.number().int().min(1000).max(30000).default(1000),
  lpMaxAgeMs: z.number().int().min(5000).max(120000).default(30000),
  lpPayoutFractionBps: z.number().int().min(1).max(10000).default(1000),
  autoStake: z.boolean().default(false), autoClaim: z.boolean().default(false),
  reserveClaimedRewards: z.boolean().default(false),
  keepRewardsMonitoring: z.boolean().default(false),
  rewardPollIntervalMs: z.number().int().min(1000).max(60000).default(1000),
  minClaimUsdc: money.default('0.01')
}).strict();
export type Config = z.infer<typeof configSchema>;
export function loadConfig(path: string): Config {
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('无法读取配置；复制 config.example.json 为 config.json 并填写资金参数'); }
  const result = configSchema.safeParse(data);
  if (!result.success) throw new Error(`配置无效：${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if(result.data.lpMaxAgeMs<result.data.lpPollIntervalMs)throw new Error('lpMaxAgeMs 不能小于 LP 轮询间隔');
  if(result.data.minLeverage>result.data.maxLeverage)throw new Error('minLeverage 不能大于 maxLeverage');
  if(result.data.costModeMinBps>result.data.costModeMaxBps)throw new Error('costModeMinBps 不能大于 costModeMaxBps');
  if(result.data.throughputCostToleranceBps>result.data.throughputAgedToleranceBps)throw new Error('久持仓成本容忍度不能小于初始值');
  return { ...result.data, stateDir: resolve(result.data.stateDir) };
}
