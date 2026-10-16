import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/config.js';
import { plannedPair, selectEfficiencyTarget, throughputTolerance } from '../src/efficiency.js';
import { efficiencyContext, executionTiming, recordCurveMinute, EMPTY_EFFICIENCY_CONTEXT } from '../src/efficiency-data.js';
import { Store } from '../src/store.js';
import { amount } from '../src/util.js';
import type { Intent, Round } from '../src/types.js';
import { market, NOW, position, protocol, wallet } from './fixtures.js';

const config=()=>configSchema.parse({marginUsdc:'500',leverage:20,strategyMode:'lpAccumulating',costModeObjective:'throughput',costModeMaxHoldMinutes:null});
const vol={sigmaBpsPerSqrtMinute:4.4,returnSamples:59,observedMinutes:59,latestMinute:Math.floor(NOW/60000),sigma5Bps:6,sigma15Bps:4.7,range15Bps:15,trendEfficiency15:0.1,signedReturn15Bps:1};
const setup=()=>{const p=protocol();p.paper.trackedLp=amount('5000000');p.paper.tail=amount('198000000');p.lpCash=p.paper.trackedLp;
  const ws=[wallet(),wallet(1)];ws.forEach(w=>w.staked=amount('1000'));return {p,ws,ps:[position(true),position(false,'2')] as [ReturnType<typeof position>,ReturnType<typeof position>]};};

test('throughput optimization obeys the 25–30% cost ceiling and relaxes smoothly with age',()=>{
  const c=config(),{p,ws,ps}=setup();
  assert.equal(throughputTolerance(c,0),2500);assert.equal(throughputTolerance(c,90*60000),2750);assert.equal(throughputTolerance(c,24*3600000),3000);
  const normal=selectEfficiencyTarget(c,market(),p,ps,vol,()=>true,ws,amount('1000'))!;
  const aged=selectEfficiencyTarget(c,market(),p,ps,vol,()=>true,ws,amount('1000'),10*3600000)!;
  assert(normal.closeMoveBps>=30&&normal.closeMoveBps<=40);
  assert(aged.closeMoveBps<=normal.closeMoveBps);
  for(const x of [normal,aged]) {
    assert(amount(x.costPerPaperUsdc)<=amount(x.closeEfficiency!.costLimitPerPaperUsdc));
    assert(x.closeEfficiency!.estimatedPaperPerHour>0);
  }
});
test('execution latency influences throughput and never disappears just because price already crossed a target',()=>{
  const c=config(),{p,ws,ps}=setup();
  const fast={...vol,sigmaBpsPerSqrtMinute:15,sigma5Bps:15,sigma15Bps:15};
  const quick=selectEfficiencyTarget(c,market(),p,ps,fast,()=>true,ws,amount('1000'))!;
  const slow=selectEfficiencyTarget(c,market(),p,ps,fast,()=>true,ws,amount('1000'),0,null,{...EMPTY_EFFICIENCY_CONTEXT,closeDelayMinutes:90,closeP90Minutes:120})!;
  assert(slow.closeMoveBps>quick.closeMoveBps);
  const crossed=selectEfficiencyTarget(c,market(),p,ps,vol,()=>true,ws,amount('1000'),10*3600000,1_004_000n)!;
  assert(crossed.closeEfficiency!.estimatedCycleMinutes>0);
  assert(crossed.closeEfficiency!.estimatedPaperPerHour<1e7);
});
test('wallet staking batches are independent and long age never waives bust or unit-cost checks',()=>{
  const c=config(),{p,ws,ps}=setup();ws[0]!.paper=amount('900');ws[1]!.paper=amount('10');
  const picked=selectEfficiencyTarget(c,market(),p,ps,vol,bps=>bps<=35,ws,amount('1000'),24*3600000)!;
  assert(picked.closeMoveBps<=35);
  assert.equal(picked.closeEfficiency!.walletBatchPlans[0]!.shortfallPaper,'100');
  assert.equal(picked.closeEfficiency!.walletBatchPlans[1]!.shortfallPaper,'990');
  assert(picked.closeEfficiency!.walletBatchPlans[1]!.estimatedLosingRounds>picked.closeEfficiency!.walletBatchPlans[0]!.estimatedLosingRounds);
  assert.equal(selectEfficiencyTarget(c,market(),p,ps,vol,()=>false,ws,amount('1000')),null);
  assert.equal(selectEfficiencyTarget(c,market(),p,ps,vol,()=>true,ws,amount('1000'),1e9,null,{...EMPTY_EFFICIENCY_CONTEXT,rateDeclinePerMinute:0.005}),null);
});
test('planned fills are adverse and real entry gap is charged exactly once in modeled exits',()=>{
  const c=config(),{p,ws,ps}=setup();
  const planned=plannedPair(market(),amount('500'),20,3);
  assert(planned[0].entry>planned[1].entry);
  const original=selectEfficiencyTarget(c,market(),p,ps,vol,()=>true,ws,amount('1000'))!;
  const spread=selectEfficiencyTarget(c,market(),p,planned,vol,()=>true,ws,amount('1000'))!;
  assert(amount(spread.closeEfficiency!.projectedCostUsdc)>0n);
  assert(amount(original.closeEfficiency!.projectedPaper)>0n);
});
test('telemetry uses first close submission, independent stake data, and a bounded observed mint-rate trend',()=>{
  const dir=mkdtempSync(join(tmpdir(),'paper-efficiency-')),s=new Store(dir);
  try {
    const {ps}=setup(),ws=[wallet(),wallet(1)];
    const legs=ps.map((p,i)=>({wallet:ws[i]!.address,position:p,openIntent:('0x'+'a'.repeat(64)) as `0x${string}`,closeIntent:null,
      settled:{id:p.id,instrumentId:0,isLong:p.isLong,margin:p.margin,leverage:p.leverage,liquidated:false,netPnl:i?-amount('30'):amount('25'),paper:i?amount('400'):0n,openedAtMs:NOW-600000,closedAtMs:NOW}})) as Round['legs'];
    const r:Round={id:1,state:'complete',reason:'30 bps 平仓触发',createdAt:NOW-660000,legs};
    const intents=ws.map((w,i)=>({id:('0x'+String(i+1).repeat(64)) as `0x${string}`,wallet:w.address,round:1,action:'closePositions',state:'succeeded',createdAt:NOW-300000,deadline:NOW/1000,ackRevision:null,signed:{}} as Intent));
    const timing=executionTiming(r,intents,new Map())!;assert.equal(timing.closeMinutes,5);assert.equal(timing.openMinutes,1);
    s.set('executionTimings',[timing]);
    for(let i=0;i<=10;i+=5){const p=protocol();p.sourceAt=NOW-(10-i)*60000;p.paper.trackedLp=p.paper.cliff;p.paper.tail=amount(String(100000000+i*1000000));recordCurveMinute(s,p);}
    const ctx=efficiencyContext(s,config(),NOW);assert.equal(ctx.closeDelayMinutes,5);assert.equal(ctx.executionSamples,1);assert(ctx.rateDeclinePerMinute>0);
    assert.equal(efficiencyContext(s,config(),NOW+10*60000).rateDeclinePerMinute,0);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
