import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { configSchema } from '../src/config.js';
import { inspectRetarget, applyRetarget, inspectEfficiencyRetarget, applyEfficiencyRetarget } from '../src/retarget.js';
import { decideStrategy } from '../src/strategy.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { TradingApi } from '../src/api.js';
import type { QuoteSource, WalletSource } from '../src/streams.js';
import type { Intent, Market, Protocol, Quote, Round, Trading } from '../src/types.js';
import { amount } from '../src/util.js';
import { identities, installSessions, market, protocol, trading, wallet } from './fixtures.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'papertrade-retarget-')),store=new Store(dir),ids=identities(),now=Date.now();
  const config=configSchema.parse({market:'BTC',marginUsdc:'333.33',leverage:31,strategyMode:'lpDynamic',autoLeverage:true,targetNotionalUsdc:'10000',capitalPerWalletUsdc:'500',maxLeverage:50,bustHeadroomBps:50,stakeTargetBps:10500,autoStake:true});
  const t:Trading=trading(),m:Market=market(),p:Protocol=protocol();
  p.sourceAt=now;p.block=200;p.paper.trackedLp=amount('2900000');p.paper.tail=amount('67000000');p.lpCash=p.paper.trackedLp;
  const ws=[wallet(),wallet(1)];for(const w of ws){w.balance=amount('500');w.available=amount('500');}
  store.bind(ids.map(i=>i.address),'BTC');installSessions(store,ws as [typeof ws[0],typeof ws[1]]);
  const original=decideStrategy(config,t,m,p,ws,now);
  assert.equal(original.closeMoveBps,27);
  const margin=amount(original.marginUsdc),entry=830195n;
  const idsHash=[('0x'+'a'.repeat(64)) as Hex,('0x'+'b'.repeat(64)) as Hex];
  const legs=ws.map((w,index)=>{
    const position={id:String(index+1),instrumentId:0,isLong:index===0,useDebt:false,entry,margin,leverage:31,
      bust:index===0?entry*97n/100n:entry*103n/100n,openedAtMs:now-30000,intentId:idsHash[index]!};
    w.balance-=margin;w.available-=margin;w.locked=margin;w.positions=[position];store.snapshot(w);
    const i:Intent={id:idsHash[index]!,wallet:w.address,round:18,action:'openPosition',state:'succeeded',createdAt:now-30000,deadline:Math.floor(now/1000)+3600,ackRevision:'1',signed:{user:w.address,nonce:String(index+1),instrumentId:'0',isLong:index===0,size:String(margin),leverage:'31',useDebt:false}};
    store.prepare(i);return{wallet:w.address,openIntent:i.id,position,closeIntent:null,settled:null};
  }) as Round['legs'];
  const round:Round={id:18,state:'hedged',createdAt:now-30000,reason:null,legs,strategy:{...original,closeMoveBps:50}};store.saveRound(round);
  store.set('runtimeCheckpoint',{at:new Date(now).toISOString(),activeRoundId:18,phase:'monitoring_hedge',liveWallets:ws.map(()=>({current:true})),tradingDataCurrent:true,lpDataCurrent:true});
  const quote:Quote={bid:830465n,ask:830465n,mid:830465n,time:now,receivedAt:now};
  return {store,dir,now,config,t,m,p,quote,input:{config,trading:t,market:m,protocol:p,quote,roundId:18,expectedBps:50,targetBps:30,now},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('preview is read-only; atomic retarget updates only the active round and records history',()=>{
  const h=fixture();try{
    const before=h.store.activeRound()!,oldIntents=h.store.intents();
    const preview=inspectRetarget(h.store,h.input);
    assert(preview.allowed,preview.reasons.join('; '));assert.equal(preview.wouldCloseAtCurrentQuote,false);
    assert.equal(h.store.activeRound()?.strategy?.closeMoveBps,50);
    const result=applyRetarget(h.store,h.input);
    assert.equal(result.auditEntries,1);assert.equal(result.fromBps,50);assert.equal(result.toBps,30);
    const updated=h.store.activeRound()!;
    assert.equal(updated.state,'hedged');assert.equal(updated.strategy?.closeMoveBps,30);
    assert.equal(updated.manualRetargets?.[0]?.fromBps,50);
    assert.deepEqual(updated.legs.map(l=>l.position?.id),before.legs.map(l=>l.position?.id));
    assert.deepEqual(h.store.intents(),oldIntents);
    const reader=new Store(h.dir,true);try{assert.equal(reader.activeRound()?.strategy?.closeMoveBps,30);}finally{reader.close();}
  }finally{h.close();}
});
test('efficiency hot adoption keeps positions, signing history and stake accounts intact',()=>{
  const h=fixture();
  try {
    for(const w of h.store.snapshots()){w.staked=amount('1000');h.store.snapshot(w);}
    const minute=Math.floor(h.now/60000);
    h.store.set('priceMinutes',Array.from({length:22},(_,i)=>({minute:minute-22+i,mid:String(830195+(i%2?500:0))})));
    const config={...h.config,strategyMode:'lpAccumulating' as const,costModeObjective:'throughput' as const,costModeMaxHoldMinutes:null};
    const input={...h.input,config};
    const before=h.store.activeRound()!,intents=h.store.intents();
    const preview=inspectEfficiencyRetarget(h.store,input);assert(preview.allowed,preview.reasons.join('; '));
    assert(preview.toBps<50);assert(preview.optimization?.closeEfficiency);
    const result=applyEfficiencyRetarget(h.store,input),after=h.store.activeRound()!;
    assert.equal(after.strategy?.costModeObjective,'throughput');assert.equal(after.strategy?.costModeMaxHoldMinutes,null);
    assert.equal(after.strategy?.closeMoveBps,result.toBps);
    assert.deepEqual(after.legs,before.legs);assert.deepEqual(h.store.intents(),intents);
    assert.throws(()=>applyEfficiencyRetarget(h.store,input),/原阈值已变化/);
  }finally{h.close();}
});
test('efficiency hot adoption refuses an already-crossed target unless explicitly acknowledged',()=>{
  const h=fixture();
  try {
    for(const w of h.store.snapshots()){w.staked=amount('1000');h.store.snapshot(w);}
    const minute=Math.floor(h.now/60000);h.store.set('priceMinutes',Array.from({length:22},(_,i)=>({minute:minute-22+i,mid:String(830195+(i%2?500:0))})));
    const input={...h.input,config:{...h.config,strategyMode:'lpAccumulating' as const,costModeObjective:'throughput' as const},quote:{...h.quote,mid:833600n}};
    const preview=inspectEfficiencyRetarget(h.store,input);assert.equal(preview.wouldCloseAtCurrentQuote,true);assert(!preview.allowed);
    assert(inspectEfficiencyRetarget(h.store,{...input,acceptImmediateClose:true}).allowed);
  }finally{h.close();}
});

test('an existing engine instance picks up the committed threshold on its next tick without restart',async()=>{
  const h=fixture();
  try {
    const liveQuotes:QuoteSource={latest:h.quote,start(){},stop(){}};
    const sources=new Map<Address,WalletSource>(h.store.snapshots().map(w=>[w.address,{latest:w,current:true,start(){},stop(){}}]));
    const submitted:Intent[]=[];
    const api:TradingApi={trading:async()=>h.t,protocol:async()=>h.p,history:async()=>[],pendingReward:async()=>0n,cancel:async()=> 'pending',
      submit:async(i)=>{submitted.push(i);return{intentId:i.id,action:i.action,state:'queued',queueRevision:2n};}};
    const engine=new Engine(h.config,identities(),h.store,api,{now:()=>h.now,sources,quotes:liveQuotes});
    await engine.tick();assert.equal(h.store.activeRound()?.state,'hedged');assert.equal(submitted.length,0);
    applyRetarget(h.store,h.input);
    liveQuotes.latest={bid:833100n,ask:833100n,mid:833100n,time:h.now,receivedAt:h.now};
    await engine.tick();await engine.drainBackground();
    assert.equal(h.store.activeRound()?.state,'closing');assert.match(h.store.activeRound()?.reason??'',/30 bps/);
    assert.equal(submitted.filter(i=>i.action==='closePositions').length,2);
  }finally{h.close();}
});

test('retarget refuses stale round, duplicate update, weak mint, unsafe price or already-closing state',()=>{
  const h=fixture();try{
    assert(!inspectRetarget(h.store,{...h.input,roundId:17}).allowed);
    const crossed={...h.quote,mid:833500n,bid:833500n,ask:833500n};
    assert(!inspectRetarget(h.store,{...h.input,quote:crossed}).allowed);
    assert(inspectRetarget(h.store,{...h.input,quote:crossed,acceptImmediateClose:true}).allowed);
    const weak={...h.p,paper:{...h.p.paper,rate:amount('1')}};
    assert(!inspectRetarget(h.store,{...h.input,protocol:weak}).allowed);
    applyRetarget(h.store,h.input);
    assert.throws(()=>applyRetarget(h.store,h.input),/原阈值已变化/);
    const r=h.store.activeRound()!;r.state='closing';h.store.saveRound(r);
    assert(!inspectRetarget(h.store,{...h.input,expectedBps:30,targetBps:25}).allowed);
  }finally{h.close();}
});

test('an old active LP round can adopt the two-loss accumulation target without requiring one-round stake',()=>{
  const h=fixture();try{
    const config={...h.config,strategyMode:'lpAccumulating' as const,accumulationMinBps:15,accumulationRounds:2};
    const input={...h.input,config,targetBps:15};
    const preview=inspectRetarget(h.store,input);
    assert(preview.allowed,preview.reasons.join('; '));
    assert(amount(preview.estimatedConservativePaper)<amount(preview.requiredPaper));
    assert.equal(preview.plannedLossesPerWallet,2);
    assert(amount(preview.projectedPaperAfterRounds!)>=amount(preview.requiredPaper));
    const applied=applyRetarget(h.store,input);
    assert.equal(applied.toBps,15);assert.equal(h.store.activeRound()?.strategy?.mode,'lpAccumulating');
    assert.equal(h.store.activeRound()?.strategy?.plannedLossesPerWallet,2);
  }finally{h.close();}
});
