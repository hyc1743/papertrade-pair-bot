import { z } from 'zod';
import type { Address, Hex } from 'viem';
import type { ClosedPosition, Market, Position, Protocol, Trading, Wallet } from './types.js';
import { WAD } from './types.js';

const uint = (bits = 256) => z.string().regex(/^(0|[1-9]\d*)$/).refine(s => BigInt(s) < 1n << BigInt(bits));
const u = uint();
const signed = z.string().regex(/^(0|-?[1-9]\d*)$/).refine(s => BigInt(s) > -(1n << 256n) && BigInt(s) < 1n << 256n);
const integer = z.number().int().nonnegative().safe();
const addr = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const positionTuple = z.tuple([u, integer, z.boolean(), z.boolean(), uint(64), uint(128), integer.positive(), uint(64), integer, hash.nullable()]);
const closedTuple = z.tuple([u, integer, z.boolean(), uint(128), integer.positive(), z.boolean(), signed, u]);
const operationTuple = z.tuple([hash, z.enum(['openPosition','closePositions','withdrawToCore','registerSessionKey','paperStake','paperUnstake','paperClaim','paperDistribute']), integer.nullable(), z.boolean().nullable(), z.boolean().nullable(), u.nullable(), integer.nullable(), integer, uint(64), z.array(u).min(1).max(12).nullable()]);
const outcomeTuple = z.tuple([hash, z.enum(['succeeded','failed','expired','cancelled','unknown'])]);
const fields = z.object({
  indexedThroughBlock: integer, indexedThroughTimestamp: integer, walletRevision: integer,
  queueRevision: uint(64), balance: u, queued: u, locked: u,
  sessionKeys: z.array(z.tuple([addr, uint(64)])), queueNodeCount: integer, consumableDebt: u,
  funds: z.object({ reservedBalance:u, reservedQueued:u, availableBalance:u, availableQueued:u }),
  paper: z.object({ balance:u, staked:u, pendingBase:u, rewardDebt:u })
});
const lifetime = z.object({ depositedRaw:u, withdrawnRaw:u, realizedPnlRaw:signed, feesPaidRaw:u, tradedNotionalRaw:u, paperRewardsClaimedRaw:u });
export const walletFrameSchema = fields.extend({ address:addr, accountRevision:integer.positive(), lifetime, openPositions:z.array(positionTuple), operations:z.array(operationTuple) });
const patchSchema = z.object({ address:addr, baseAccountRevision:integer.positive(), accountRevision:integer.positive(), state:fields.partial(), lifetime:lifetime.optional(), addedPositions:z.array(positionTuple), removedPositionIds:z.array(u), addedOperations:z.array(operationTuple), removedOperationIds:z.array(hash), closedPositions:z.array(closedTuple).optional(), intentOutcomes:z.array(outcomeTuple).optional() });
export type WalletFrame = z.infer<typeof walletFrameSchema>;
export interface DecodedWallet { frame: WalletFrame; wallet: Wallet }
function unique<T>(items: T[], key: (item:T)=>string): void {
  if (new Set(items.map(key)).size !== items.length) throw new Error('Duplicate live-state identifier');
}
function patchList<T>(current:T[], adds:T[], removes:string[], key:(item:T)=>string): T[] {
  unique(adds,key); unique(removes,x=>x);
  const map = new Map(current.map(x=>[key(x),x]));
  for (const id of removes) if (!map.delete(id)) throw new Error('Unknown removed live-state identifier');
  for (const x of adds) { if (map.has(key(x)) || removes.includes(key(x))) throw new Error('Duplicate added live-state identifier'); map.set(key(x),x); }
  return [...map.values()];
}
export function decodeWallet(input:unknown, previous:WalletFrame|null, expected:Address, requireFull=false): DecodedWallet {
  let frame:WalletFrame;
  let closed:z.infer<typeof closedTuple>[]=[];
  let outcomes:z.infer<typeof outcomeTuple>[]=[];
  const isPatch = !!input && typeof input === 'object' && 'baseAccountRevision' in input;
  if (isPatch) {
    const p=patchSchema.parse(input);
    if (requireFull || !previous || p.baseAccountRevision!==previous.accountRevision || p.accountRevision<=previous.accountRevision) throw new Error('Account stream out of sync');
    frame=walletFrameSchema.parse({ ...previous, ...p.state, address:p.address, accountRevision:p.accountRevision, lifetime:p.lifetime??previous.lifetime,
      openPositions:patchList(previous.openPositions,p.addedPositions,p.removedPositionIds,x=>x[0]),
      operations:patchList(previous.operations,p.addedOperations,p.removedOperationIds,x=>x[0]) });
    closed=p.closedPositions??[]; outcomes=p.intentOutcomes??[];
  } else frame=walletFrameSchema.parse(input);
  if(frame.address!==expected.toLowerCase() || frame.walletRevision>frame.indexedThroughBlock) throw new Error('Account stream identity/revision mismatch');
  unique(frame.openPositions,x=>x[0]); unique(frame.operations,x=>x[0]); unique(frame.sessionKeys,x=>x[0]); unique(closed,x=>x[0]); unique(outcomes,x=>x[0]);
  const positions:Position[]=frame.openPositions.map(x=>({ id:x[0], instrumentId:x[1], isLong:x[2], useDebt:x[3], entry:BigInt(x[4]), margin:BigInt(x[5]), leverage:x[6], bust:BigInt(x[7]), openedAtMs:x[8], intentId:x[9] as Hex|null }));
  if(positions.some(p=>p.entry<=0n || p.margin<=0n) || positions.reduce((v,p)=>v+p.margin,0n)!==BigInt(frame.locked)) throw new Error('Account position/margin invariant failed');
  for (const [reserved,total,available] of [[frame.funds.reservedBalance,frame.balance,frame.funds.availableBalance],[frame.funds.reservedQueued,frame.queued,frame.funds.availableQueued]]) {
    const remain=BigInt(total!)-BigInt(reserved!);
    if(BigInt(available!)!==(remain>0n?remain:0n)) throw new Error('Account available-funds invariant failed');
  }
  const settled:ClosedPosition[]=closed.map(x=>({id:x[0], instrumentId:x[1], isLong:x[2], margin:BigInt(x[3]), leverage:x[4], liquidated:x[5], netPnl:BigInt(x[6]), paper:BigInt(x[7])}));
  return { frame, wallet: { address:frame.address as Address, revision:frame.accountRevision, block:frame.indexedThroughBlock, timestamp:frame.indexedThroughTimestamp,
    queueRevision:BigInt(frame.queueRevision), balance:BigInt(frame.balance), queued:BigInt(frame.queued), locked:BigInt(frame.locked), available:BigInt(frame.funds.availableBalance),
    sessions:Object.fromEntries(frame.sessionKeys.map(([a,t])=>[a,BigInt(t)])), paper:BigInt(frame.paper.balance), staked:BigInt(frame.paper.staked), claimedRewards:BigInt(frame.lifetime.paperRewardsClaimedRaw), withdrawn:BigInt(frame.lifetime.withdrawnRaw), realizedPnl:BigInt(frame.lifetime.realizedPnlRaw), positions,
    operations:frame.operations.map(x=>({id:x[0] as Hex,action:x[1],deadline:BigInt(x[8]),positionIds:x[9]??[]})), closed:settled,
    outcomes:outcomes.map(([id,outcome])=>({id:id as Hex,outcome})) } };
}

const marketTuple=z.tuple([integer,z.enum(['BTC','ETH']),integer,uint(64),z.boolean(),z.boolean(),z.boolean(),z.boolean(),z.boolean(),uint(64).nullable(),uint(64).nullable(),integer.nullable(),uint(96),uint(96),integer.positive(),uint(128),u,u,uint(128),uint(96),uint(96),uint(128),uint(128)]);
const tradingSchema=z.object({schemaVersion:z.literal(1),indexedThroughBlock:integer,tradingPaused:z.boolean(),minimumTradeSizeRaw:u,minimumOpenNotionalRaw:u,instruments:z.array(marketTuple),
  intake:z.tuple([integer,u,u,z.array(z.string())]).optional(),
  intakeControls:z.tuple([integer,u,z.array(z.string())]).optional()})
  .refine(x=>(x.intake===undefined)!==(x.intakeControls===undefined),{message:'Expected one official intake schema'});
export function decodeTrading(input:unknown):Trading {
  const f=tradingSchema.parse(input);
  const markets:Market[]=f.instruments.map(x=>{
    if(x[6]!==x[5] || x[8]!==x[5] || x[7] !== (x[5]||!x[4])) throw new Error('Unsupported market lifecycle');
    if(x[5] ? x[9]===null||x[10]===null||x[11]===null : x[9]!==null||x[10]!==null||x[11]!==null) throw new Error('Invalid frozen market state');
    if(BigInt(x[3])<=0n || BigInt(x[16])>=WAD || BigInt(x[17])>=WAD || BigInt(x[12])<=0n || BigInt(x[13])<=0n) throw new Error('Unsupported market parameters');
    if(x[0]!==x[2] || x[0] !== (x[1]==='BTC'?0:1) || BigInt(x[3]) !== (x[1]==='BTC'?10n:100n)) throw new Error('Deployment market mismatch');
    return {id:x[0],symbol:x[1],assetIndex:x[2],priceScale:BigInt(x[3]),active:x[4],paused:x[5],retired:x[7],closeOnly:x[8],frozenBid:x[9]===null?null:BigInt(x[9]),frozenAsk:x[10]===null?null:BigInt(x[10]),rateMultiplier:BigInt(x[12]),positionMultiplier:BigInt(x[13]),maxLeverage:x[14],maxNotional:BigInt(x[15]),bustBuffer:BigInt(x[16]),baseRate:BigInt(x[17]),referenceNotional:BigInt(x[18]),longOi:BigInt(x[19]),shortOi:BigInt(x[20]),longCap:BigInt(x[21]),shortCap:BigInt(x[22])};
  });
  unique(markets,x=>String(x.id));
  // The newer intakeControls schema no longer advertises a net-OI cap. A zero
  // sentinel disables only that absent check; per-direction caps and the
  // configured OI headroom/stability gate remain mandatory.
  return {block:f.indexedThroughBlock,paused:f.tradingPaused,minMargin:BigInt(f.minimumTradeSizeRaw),minNotional:BigInt(f.minimumOpenNotionalRaw),markets,
    disabledActions:f.intake?.[3]??f.intakeControls![2],maxNetOi:f.intake?BigInt(f.intake[2]):0n,minPaperStake:BigInt(f.intake?.[1]??f.intakeControls![1])};
}
const protocolSchema=z.object({ok:z.literal(true),source:z.object({block:u,at:integer}),balances:z.object({lp:u,queue:u}),fees:z.object({pending:u,lifetime:u}),paper:z.object({trackedLp:signed,tailProgress:u,cliff:u,cap:u,rate:u,decay:u,staked:u,pendingRewards:u})});
export function decodeProtocol(input:unknown):Protocol {
  const f=protocolSchema.parse(input);
  if(BigInt(f.paper.decay)<=0n) throw new Error('Invalid mint curve');
  const block=Number(f.source.block);if(!Number.isSafeInteger(block))throw new Error('Unsafe protocol block');
  return {block,sourceAt:f.source.at,lpCash:BigInt(f.balances.lp),queue:BigInt(f.balances.queue),feesPending:BigInt(f.fees.pending),feesLifetime:BigInt(f.fees.lifetime),paper:{trackedLp:BigInt(f.paper.trackedLp),tail:BigInt(f.paper.tailProgress),cliff:BigInt(f.paper.cliff),cap:BigInt(f.paper.cap),rate:BigInt(f.paper.rate),decay:BigInt(f.paper.decay),staked:BigInt(f.paper.staked),pendingRewards:BigInt(f.paper.pendingRewards)}};
}
