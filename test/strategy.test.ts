import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../src/config.js';
import { decideStrategy, mintRate, selectCostModeTarget } from '../src/strategy.js';
import { checkOpen } from '../src/math.js';
import { amount } from '../src/util.js';
import { market, NOW, protocol, trading, wallet } from './fixtures.js';

const cfg=()=>configSchema.parse({marginUsdc:'200',leverage:50,maxNetLossUsdc:null,strategyMode:'lpDynamic',capitalPerWalletUsdc:'300',autoStake:true});
const ws=()=>[wallet(),wallet(1)].map(w=>({...w,balance:amount('300'),available:amount('300')}));
test('null hold horizon removes candidate filtering but does not impose any timed close',()=>{
  const c=cfg(),volatility={sigmaBpsPerSqrtMinute:1,returnSamples:59,observedMinutes:60,latestMinute:1};
  const bounded=selectCostModeTarget({...c,costModeMaxHoldMinutes:480},market(),protocol(),amount('200'),50,volatility,()=>true);
  const unbounded=selectCostModeTarget({...c,costModeMaxHoldMinutes:null},market(),protocol(),amount('200'),50,volatility,()=>true);
  assert.equal(bounded?.closeMoveBps,25);
  assert.equal(bounded?.horizonSatisfied,false);
  assert.equal(unbounded?.closeMoveBps,100);
  assert.equal(unbounded?.horizonSatisfied,true);
  assert((unbounded?.estimatedHoldMinutes??0)>480);
  assert.equal(decideStrategy({...c,costModeMaxHoldMinutes:null},trading(),market(),protocol(),ws(),NOW).costModeMaxHoldMinutes,null);
});
test('300U per wallet: activate at 25 bps without raising leverage or using all cash',()=>{
  const c=cfg(),t=trading(),p=protocol(),w=ws(),d=decideStrategy(c,t,market(),p,w,NOW);
  assert(d.canOpen);assert.equal(d.phase,'activation');assert.equal(d.closeMoveBps,25);assert.equal(d.marginUsdc,'200');assert.equal(d.leverage,50);assert.equal(d.notionalUsdc,'10000');
  assert.equal(d.expectedPaper,'2450');assert.deepEqual(checkOpen({...c,closeMoveBps:d.closeMoveBps,marginUsdc:d.marginUsdc},t,market(),w,1000000n),[]);
});
test('real staking state switches 25 -> 50; funded surplus with fee activity switches to 100',()=>{
  const c=cfg(),t=trading(),p=protocol(),w=ws();w[1]!.staked=amount('2450');
  assert.equal(decideStrategy(c,t,market(),p,w,NOW).closeMoveBps,50);
  p.paper.trackedLp=amount('5000000');p.lpCash=amount('5000000');
  assert.equal(decideStrategy(c,t,market(),p,w,NOW).phase,'fees');
  p.feesLifetime=amount('1');const d=decideStrategy(c,t,market(),p,w,NOW);assert(d.canOpen);assert.equal(d.phase,'surplus');assert.equal(d.closeMoveBps,100);
});
test('high tail progress uses the real curve, never current LP as a proxy; threshold escalates to meet stake minimum',()=>{
  const c=cfg(),t=trading(),p=protocol();p.paper.trackedLp=p.paper.cliff;p.lpCash=amount('2000000');p.paper.tail=amount('100000000');
  const d=decideStrategy(c,t,market(),p,ws(),NOW);
  assert(mintRate(p)>amount('29')&&mintRate(p)<amount('30'));assert(d.canOpen);assert.equal(d.closeMoveBps,37);
  p.paper.tail=amount('1000000000');assert(!decideStrategy(c,t,market(),p,ws(),NOW).canOpen);
});
test('105% staking target selects the first safe 1 bps step and models the worst admitted entry gap',()=>{
  const c=cfg(),p=protocol();p.paper.cliff=0n;p.paper.rate=amount('37.5');p.lpCash=amount('1000');
  const lower=decideStrategy(c,trading(),market(),p,ws(),NOW);
  const older=decideStrategy({...c,stakeTargetBps:11000},trading(),market(),p,ws(),NOW);
  assert.equal(c.stakeTargetBps,10500);assert(lower.canOpen,lower.reasons.join('; '));
  assert.equal(lower.stakeTargetPaper,'1050');assert.equal(lower.closeMoveBps,30);
  assert(amount(lower.conservativePaper!)>=amount('1050')&&amount(lower.conservativePaper!)<amount('1100'));
  assert.equal(older.closeMoveBps,31);
});
test('current tail-like rate uses 27 bps for next activation while a persisted round remains frozen',()=>{
  const c=configSchema.parse({marginUsdc:'333.33',leverage:31,maxNetLossUsdc:null,strategyMode:'lpDynamic',capitalPerWalletUsdc:'500',targetNotionalUsdc:'10000',autoLeverage:true,maxLeverage:50,bustHeadroomBps:50,autoStake:true});
  const p=protocol(),w=ws();w.forEach(x=>{x.balance=amount('500');x.available=amount('500');});
  p.paper.trackedLp=amount('2865366.764013');p.paper.tail=amount('66746697.991411');p.lpCash=p.paper.trackedLp;
  const next=decideStrategy(c,trading(),market(),p,w,NOW);
  assert(next.canOpen,next.reasons.join('; '));assert.equal(next.phase,'activation');assert.equal(next.closeMoveBps,27);
  assert(amount(next.conservativePaper!)>=amount(next.stakeTargetPaper!));
  w[1]!.staked=amount('1000');assert.equal(decideStrategy(c,trading(),market(),p,w,NOW).closeMoveBps,50);
});
test('queues, stale or future source times pause new trades but not by inventing a net-loss budget',()=>{
  const c=cfg(),t=trading(),p=protocol(),w=ws();assert.equal(c.maxNetLossUsdc,null);
  p.queue=1n;assert(!decideStrategy(c,t,market(),p,w,NOW).canOpen);p.queue=0n;
  w[0]!.queued=1n;assert(!decideStrategy(c,t,market(),p,w,NOW).canOpen);w[0]!.queued=0n;
  p.sourceAt=NOW-31000;assert(!decideStrategy(c,t,market(),p,w,NOW).canOpen);
  p.sourceAt=NOW+6000;assert(!decideStrategy(c,t,market(),p,w,NOW).canOpen);
});
test('insufficient cash pauses instead of secretly increasing leverage or borrowing debt',()=>{
  const c=cfg(),w=ws();w[0]!.available=amount('175');w[0]!.queued=amount('10000');
  const d=decideStrategy(c,trading(),market(),protocol(),w,NOW);assert(!d.canOpen);assert.equal(d.leverage,50);assert(d.reasons.some(x=>x.includes('现金不足')));
});
test('LP payment budget can shrink configured positions, but never below minimum notional',()=>{
  const c={...cfg(),marginUsdc:'600',capitalPerWalletUsdc:null},p=protocol(),w=ws();w.forEach(x=>x.available=amount('1000'));p.paper.trackedLp=p.paper.cliff;
  w[0]!.staked=amount('1000');
  p.lpCash=amount('700');const d=decideStrategy(c,trading(),market(),p,w,NOW);assert(d.canOpen);assert(amount(d.marginUsdc)<amount('600'));assert(amount(d.notionalUsdc)>=amount('10000'));
  p.lpCash=amount('1');assert(!decideStrategy(c,trading(),market(),p,w,NOW).canOpen);
});
test('a raised stake minimum selects the lowest safe 1 bps step; unsafe leverage still pauses',()=>{
  const t=trading();t.minPaperStake=amount('7000');
  assert.equal(decideStrategy(cfg(),t,market(),protocol(),ws(),NOW).closeMoveBps,76);
  const c={...cfg(),leverage:100,marginUsdc:'100'};assert(!decideStrategy(c,t,market(),protocol(),ws(),NOW).canOpen);
});
