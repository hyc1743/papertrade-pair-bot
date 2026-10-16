import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { configSchema } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { netPnl } from '../src/math.js';
import { amount } from '../src/util.js';
import { WAD, type Intent, type Receipt, type Wallet } from '../src/types.js';
import { ApiError, type TradingApi } from '../src/api.js';
import type { QuoteSource, WalletSource } from '../src/streams.js';
import { identities, installSessions, market, NOW, protocol, trading, wallet } from './fixtures.js';
import type { MinutePrice } from '../src/volatility.js';

function setup(options:Record<string,unknown>={}) {
  const dir=mkdtempSync(join(tmpdir(),'papertrade-dynamic-')),s=new Store(dir),ids=identities();
  const {rewardsOnly,seedMinutes,...settings}=options;
  const c=configSchema.parse({marginUsdc:'200',leverage:50,maxNetLossUsdc:null,strategyMode:'lpDynamic',autoStake:true,autoClaim:true,keepRewardsMonitoring:true,alternateDirections:true,capitalPerWalletUsdc:'300',openIntentTtlSeconds:300,...settings});
  const h={now:NOW,store:s,config:c,api:null as unknown as TradingApi,engine:null as unknown as Engine,ws:[wallet(),wallet(1)] as [Wallet,Wallet],sources:new Map<Address,WalletSource>(),
    q:{latest:{bid:1000000n,ask:1000000n,mid:1000000n,time:NOW,receivedAt:NOW},start(){},stop(){}} as QuoteSource,
    t:trading(),p:protocol(),submitted:[] as Intent[],pending:new Map<Address,bigint>(),reads:0,serial:0,
    hook:null as ((i:Intent)=>void|Promise<void>)|null,
    publish(index:number,patch:Partial<Wallet>) {const w={...h.ws[index]!,closed:[],outcomes:[],revision:h.ws[index]!.revision+1,timestamp:Math.floor(h.now/1000),...patch};h.ws[index]=w;h.sources.get(w.address)!.latest=w;h.engine.observe(w);},
    fill(i:Intent) {
      const idx=ids.findIndex(x=>x.address===i.wallet),w=h.ws[idx]!,lev=Number(i.signed.leverage),margin=BigInt(String(i.signed.size)),entry=h.q.latest!.mid;
      const long=i.signed.isLong===true,distance=WAD/BigInt(lev)-market().bustBuffer;
      const pos={id:String(++h.serial),instrumentId:0,isLong:long,useDebt:false,entry,margin,leverage:lev,bust:entry*(long?WAD-distance:WAD+distance)/WAD,openedAtMs:h.now,intentId:i.id};
      h.publish(idx,{positions:[pos],locked:margin,balance:w.balance-margin,available:w.available-margin,outcomes:[{id:i.id,outcome:'succeeded'}]});
    },
    closePosition(i:Intent) {
      const idx=ids.findIndex(x=>x.address===i.wallet),w=h.ws[idx]!,p=w.positions[0]!,pnl=netPnl(p,h.q.latest!.mid,market());
      const paper=pnl<0n?-pnl*98n:0n,closed={id:p.id,instrumentId:0,isLong:p.isLong,margin:p.margin,leverage:p.leverage,liquidated:false,netPnl:pnl,paper};
      h.publish(idx,{positions:[],locked:0n,balance:w.balance+p.margin+pnl,available:w.available+p.margin+pnl,realizedPnl:w.realizedPnl+pnl,paper:w.paper+paper,closed:[closed],outcomes:[{id:i.id,outcome:'succeeded'}]});
    },
    auto(i:Intent) {
      const idx=ids.findIndex(x=>x.address===i.wallet),w=h.ws[idx]!;
      if(i.action==='openPosition')h.fill(i);
      else if(i.action==='closePositions')h.closePosition(i);
      else if(i.action==='paperStake'){const n=BigInt(String(i.signed.amount));h.publish(idx,{paper:w.paper-n,staked:w.staked+n,outcomes:[{id:i.id,outcome:'succeeded'}]});}
      else if(i.action==='paperClaim'){const n=h.pending.get(w.address)??0n;h.pending.set(w.address,0n);h.publish(idx,{claimedRewards:w.claimedRewards+n,balance:w.balance+n,available:w.available+n,outcomes:[{id:i.id,outcome:'succeeded'}]});}
      else h.publish(idx,{sessions:{...w.sessions,[String(i.signed.key)]:BigInt(String(i.signed.expiry))},outcomes:[{id:i.id,outcome:'succeeded'}]});
    },
    fresh(ms=1001,price?:bigint) {h.now+=ms;h.q.latest={...h.q.latest!,time:h.now,receivedAt:h.now,...price===undefined?{}:{mid:price,bid:price,ask:price}};},
    async tick(){await h.engine.tick();await h.engine.rewards.drain();},
    async shutdown(){await h.engine.rewards.shutdown();await h.engine.drainBackground();s.close();rmSync(dir,{recursive:true,force:true});},
    restart(only=false){return new Engine(c,ids,s,api,{now:()=>h.now,sources:h.sources,quotes:h.q,rewardsOnly:only});}
  };
  h.ws.forEach(w=>{w.balance=amount('300');w.available=amount('300');h.sources.set(w.address,{latest:w,current:true,start(){},stop(){}});});
  installSessions(s,h.ws);
  if(seedMinutes)s.set('priceMinutes',seedMinutes);
  const api:TradingApi={trading:async()=>h.t,protocol:async()=>({...h.p,sourceAt:h.now}),pendingReward:async(a)=>{h.reads++;return h.pending.get(a)??0n;},history:async()=>[],cancel:async()=> 'pending',
    submit:async(i)=>{h.submitted.push(i);if(h.hook)await h.hook(i);else h.auto(i);return {intentId:i.id,action:i.action,state:'queued',queueRevision:1n} as Receipt;}};
  h.api=api;h.engine=new Engine(c,ids,s,api,{now:()=>h.now,sources:h.sources,quotes:h.q,rewardsOnly:rewardsOnly===true});
  h.ws.forEach(w=>h.engine.observe(w));return h;
}
test('activation closes at 25 bps, stakes immediately, freezes old threshold and next round uses 50 bps',async()=>{
  const h=setup();
  try {
    await h.tick();await h.tick();assert.equal(h.store.activeRound()!.strategy!.closeMoveBps,25);
    h.fresh(1001,1002500n);await h.tick();assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,0);
    h.p.paper.trackedLp=amount('6000000');h.p.lpCash=amount('6000000');h.p.feesLifetime=amount('1'); // Do not enlarge the already-open target.
    h.fresh(1001,1002501n);await h.tick();assert.equal(h.store.activeRound(),null);assert(h.ws[1].staked>=amount('2450'));
    assert.equal(h.submitted.filter(i=>i.action==='paperStake').length,1);
    h.p.paper.trackedLp=0n;h.fresh();await h.tick();const next=h.store.activeRound()!;assert.equal(next.strategy!.closeMoveBps,50);
    const opens=h.submitted.filter(i=>i.action==='openPosition');assert.equal(opens[2]!.signed.isLong,false);assert.equal(opens[3]!.signed.isLong,true);
  }finally{await h.shutdown();}
});
test('hedged round adds its actual entry-price gap to the exit trigger',async()=>{
  const h=setup({maxEntryGapBps:3,autoClaim:false});
  try {
    let opens=0;
    h.hook=i=>{
      h.auto(i);
      if(i.action==='openPosition'&&++opens===2){
        const idx=h.ws.findIndex(w=>w.address===i.wallet),w=h.ws[idx]!,pos=w.positions[0]!;
        const entry=1_000_200n,distance=WAD/BigInt(pos.leverage)-market().bustBuffer;
        h.publish(idx,{positions:[{...pos,entry,bust:entry*(pos.isLong?WAD-distance:WAD+distance)/WAD}]});
      }
    };
    await h.tick();await h.tick();
    assert.equal(h.store.activeRound()?.state,'hedged');
    assert.equal(h.store.activeRound()?.strategy?.closeMoveBps,25);
    h.fresh(1001,1_002_601n);await h.tick();
    assert.equal(h.store.activeRound()?.state,'hedged');
    assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,0);
    h.fresh(1001,1_002_801n);await h.tick();
    assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,2);
  }finally{await h.shutdown();}
});
test('a heartbeating wallet far behind the trading index cannot authorize a new round',async()=>{
  const h=setup({autoClaim:false});
  try {
    h.t.block=200;
    await h.tick();
    assert.equal(h.store.activeRound(),null);
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,0);
    const checkpoint=h.store.get<{liveWallets:{current:boolean}[]}>('runtimeCheckpoint');
    assert(checkpoint?.liveWallets.every(w=>!w.current));
    h.publish(0,{block:199});h.publish(1,{block:199});h.fresh();
    await h.tick();
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{await h.shutdown();}
});
test('short account or quote gap during queued opens does not permanently halt trading',async()=>{
  const h=setup({autoClaim:false,hedgedDataGraceMs:15000});
  try {
    h.hook=i=>{if(i.action!=='openPosition')h.auto(i);};
    await h.tick();assert.equal(h.store.activeRound()?.state,'opening');
    const quote=h.q.latest!;h.q.latest=null;h.now+=1001;
    await h.tick();assert.equal(h.store.activeRound()?.state,'opening');
    h.now+=5000;await h.tick();assert.equal(h.store.activeRound()?.state,'opening');
    h.q.latest={...quote,time:h.now,receivedAt:h.now};await h.tick();
    assert.equal(h.store.activeRound()?.state,'opening');
    assert.equal(h.store.get('tradeStoppedReason'),null);
    assert.equal(h.store.get('activeOpeningDataGap'),null);
  }finally{await h.shutdown();}
});
test('confirmed empty opening after a long data outage cools down and retries instead of halting forever',async()=>{
  const h=setup({autoClaim:false,hedgedDataGraceMs:15000});
  try {
    h.hook=i=>{if(i.action!=='openPosition')h.auto(i);};
    h.api.cancel=async()=> 'cancelled';
    await h.tick();assert.equal(h.store.activeRound()?.state,'opening');
    h.now+=6001;await h.tick();
    h.now+=16000;await h.tick();assert.equal(h.store.activeRound()?.state,'recovering');
    await h.engine.drainBackground();await h.tick();
    assert.equal(h.store.activeRound(),null);
    assert.equal(h.store.rounds().at(-1)?.reason,'行情或账户状态中断');
    assert.equal(h.store.get('tradeStoppedReason'),null);
    assert((h.store.get<number>('nextOpenAttemptAt')??0)>=h.now+30000);
  }finally{await h.shutdown();}
});
test('opening data timeout with one real fill still exits that position and remains halted',async()=>{
  const h=setup({autoClaim:false,hedgedDataGraceMs:15000});
  try {
    let opens=0;
    h.hook=i=>{if(i.action==='openPosition'){if(++opens===1)h.auto(i);}else h.auto(i);};
    h.api.cancel=async()=> 'cancelled';
    await h.tick();assert.equal(h.store.activeRound()?.state,'opening');
    assert.equal(h.store.activeRound()?.legs.filter(l=>l.position).length,1);
    h.now+=6001;await h.tick();
    h.now+=16000;await h.tick();
    await h.engine.drainBackground();await h.tick();
    assert.equal(h.store.activeRound(),null);
    assert.equal(h.store.get('tradeStoppedReason'),'行情或账户状态中断');
    assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,1);
  }finally{await h.shutdown();}
});
test('accumulating mode recomputes the close target while hedged without another open',async()=>{
  const h=setup({strategyMode:'lpAccumulating',autoClaim:false,slowCloseAfterMs:30000,slowCloseFloorBps:10});
  try {
    await h.tick();await h.tick();
    assert.equal(h.store.activeRound()?.strategy?.closeMoveBps,15);
    const opens=h.submitted.filter(i=>i.action==='openPosition').length;
    h.fresh(31000);await h.tick();await h.engine.drainBackground();await h.tick();
    assert.equal(h.store.activeRound()?.state,'hedged');
    assert.equal(h.store.activeRound()?.strategy?.closeMoveBps,12);
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,opens);
    h.p.paper.rate=amount('1');h.fresh();await h.tick();await h.engine.drainBackground();await h.tick();
    assert.equal(h.store.activeRound()?.strategy?.closeMoveBps,12);
  }finally{await h.shutdown();}
});
test('both-staked BTC volatility is identical in initial and post-signature open checks',async()=>{
  const minute=Math.floor(NOW/60000),seed:MinutePrice[]=Array.from({length:22},(_,i)=>({minute:minute-22+i,mid:String(1_000_000+(i%2?1000:0))}));
  const h=setup({strategyMode:'lpAccumulating',autoClaim:false,seedMinutes:seed});
  try {
    h.publish(0,{staked:amount('1000')});h.publish(1,{staked:amount('1000')});
    await h.tick();await h.tick();
    assert.equal(h.store.activeRound()?.state,'hedged');
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);
    assert(h.store.activeRound()!.strategy!.volatilitySamples!>=10);
  }finally{await h.shutdown();}
});
test('a legacy active round keeps its original 480-minute candidate policy after config disables future horizons',async()=>{
  const minute=Math.floor(NOW/60000),seed:MinutePrice[]=Array.from({length:22},(_,i)=>({minute:minute-22+i,mid:String(1_000_000+(i%2?100:0))}));
  const h=setup({strategyMode:'lpAccumulating',autoClaim:false,seedMinutes:seed,costModeMaxHoldMinutes:null});
  try {
    h.publish(0,{staked:amount('1000')});h.publish(1,{staked:amount('1000')});
    await h.tick();await h.tick();
    const r=h.store.activeRound()!;assert.equal(r.state,'hedged');
    r.strategy={...r.strategy!,costModeMaxHoldMinutes:480,closeMoveBps:50};h.store.saveRound(r);
    h.fresh();await h.tick();
    assert.equal(h.store.activeRound()?.strategy?.costModeMaxHoldMinutes,480);
    assert.equal(h.store.activeRound()?.strategy?.closeMoveBps,25);
  }finally{await h.shutdown();}
});
test('throughput policy ages its cost budget but does not close an unmoved hedge on elapsed time',async()=>{
  const minute=Math.floor(NOW/60000),seed:MinutePrice[]=Array.from({length:22},(_,i)=>({minute:minute-22+i,mid:String(1_000_000+(i%2?500:0))}));
  const h=setup({strategyMode:'lpAccumulating',autoClaim:false,seedMinutes:seed,costModeObjective:'throughput',costModeMaxHoldMinutes:null});
  try {
    h.publish(0,{staked:amount('1000')});h.publish(1,{staked:amount('1000')});
    await h.tick();await h.tick();assert.equal(h.store.activeRound()?.state,'hedged');
    h.ws.forEach((w,i)=>h.publish(i,{positions:w.positions.map(p=>({...p,openedAtMs:NOW-10*3600000}))}));
    h.fresh();await h.tick();
    assert.equal(h.store.activeRound()?.state,'hedged');
    assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,0);
    assert.equal(h.store.activeRound()?.strategy?.costModeObjective,'throughput');
    assert.equal(h.store.get<{closeEfficiency:{costToleranceBps:number}}>('liveCloseDecision')?.closeEfficiency.costToleranceBps,3000);
  }finally{await h.shutdown();}
});
test('live engine waits for three distinct OI-safe blocks before dispatching either leg',async()=>{
  const h=setup({oiHeadroomUsdc:'200000',oiStableSnapshots:3,oiStableMinMs:2000,autoClaim:false});
  try {
    await h.tick();assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,0);
    h.t={...h.t,block:h.t.block+1};h.fresh();await h.tick();assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,0);
    h.t={...h.t,block:h.t.block+1};h.fresh();await h.tick();await h.engine.drainBackground();
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{await h.shutdown();}
});
test('official OI rejection of the scarce lead leg never submits the other wallet and cools down safely',async()=>{
  const h=setup({oiHeadroomUsdc:'200000',oiAdmissionCooldownMs:120000,autoClaim:false});
  try {
    h.t.markets[0]!.longCap=amount('3');h.t.markets[0]!.shortCap=amount('100000');
    h.hook=i=>{if(i.action==='openPosition'&&i.signed.isLong===true)throw new ApiError(409,'admission_rejected',true,0,'openInterest');h.auto(i);};
    await h.tick();
    const opens=h.submitted.filter(i=>i.action==='openPosition');
    assert.equal(opens.length,1);assert.equal(opens[0]!.signed.isLong,true);
    assert.equal(h.store.activeRound(),null);
    assert.equal(h.store.get('tradeStoppedReason'),null);
    assert((h.store.get<number>('nextOpenAttemptAt')??0)>h.now);
    assert.equal(h.store.rounds().at(-1)?.reason,'先导开仓因 OI 被明确拒绝，未提交对冲侧；冷却后重新检查');
  }finally{await h.shutdown();}
});
test('staged first-leg rate limit leaves both wallets flat and retries after Retry-After',async()=>{
  const h=setup({oiHeadroomUsdc:'200000',autoClaim:false});
  try {
    h.hook=i=>{if(i.action==='openPosition')throw new ApiError(429,'rate_limited',true,5000);h.auto(i);};
    await h.tick();assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,1);
    assert.equal(h.store.activeRound(),null);assert.equal(h.store.get('tradeStoppedReason'),null);
    assert((h.store.get<number>('nextOpenAttemptAt')??0)>=h.now+5000);
  }finally{await h.shutdown();}
});
test('a brief stale quote pauses hedge decisions, records the source and recovers without forced closing',async()=>{
  const h=setup({strategyMode:'lpAccumulating',autoClaim:false,hedgedDataGraceMs:15000});
  try {
    await h.tick();await h.tick();assert.equal(h.store.activeRound()?.state,'hedged');
    h.fresh(6000);h.q.latest={...h.q.latest!,time:h.now-6000,receivedAt:h.now-6000};
    await h.tick();assert.equal(h.store.activeRound()?.state,'hedged');
    assert.equal(h.store.get<{roundId:number}>('activeDataGap')?.roundId,h.store.activeRound()?.id);
    h.fresh(1000);await h.tick();
    assert.equal(h.store.activeRound()?.state,'hedged');assert.equal(h.store.get('activeDataGap'),null);
    assert(h.store.get('lastDataGap'));assert.equal(h.store.get('lastDataFailure'),null);
  }finally{await h.shutdown();}
});
test('a sustained stale quote records exact data ages and exits the existing hedge',async()=>{
  const h=setup({strategyMode:'lpAccumulating',autoClaim:false,hedgedDataGraceMs:15000});
  try {
    await h.tick();await h.tick();h.fresh(6000);h.q.latest={...h.q.latest!,time:h.now-6000,receivedAt:h.now-6000};
    await h.tick();h.fresh(16000);h.q.latest={...h.q.latest!,time:h.now-6000,receivedAt:h.now-6000};await h.tick();
    const failure=h.store.get<{round:number;quoteAgeMs:number;tradingAgeMs:number;wallets:{current:boolean}[]}>('lastDataFailure');
    assert(failure);assert(failure.quoteAgeMs>5000);assert(failure.wallets.every(w=>w.current));
    assert.equal(h.store.get('tradeStoppedReason'),'行情或账户状态中断');
  }finally{await h.shutdown();}
});
test('staking dispatch does not wait for the winning leg HTTP request to finish',async()=>{
  const h=setup();let release:(()=>void)|undefined;
  try {
    await h.tick();await h.tick();h.fresh(1001,1002501n);
    h.hook=async(i)=>{if(i.action==='closePositions'&&i.wallet===h.ws[0].address)await new Promise<void>(r=>{release=r;});h.auto(i);};
    const pending=h.engine.tick();
    for(let n=0;n<30&&!h.submitted.some(i=>i.action==='paperStake');n++)await new Promise(r=>setTimeout(r,5));
    assert(h.submitted.some(i=>i.action==='paperStake'));assert(h.store.activeRound());release?.();await pending;await h.engine.rewards.drain();
  }finally{release?.();await h.shutdown();}
});
test('unknown staking acknowledgement reserves the amount and does not create another nonce',async()=>{
  const h=setup();
  try {
    h.publish(1,{paper:amount('2450')});h.hook=i=>{if(i.action==='paperStake')throw new Error('timeout');h.auto(i);};
    await h.tick();h.fresh(20000);await h.tick();assert.equal(h.submitted.filter(i=>i.action==='paperStake').length,1);
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,0);
    const i=h.submitted.find(i=>i.action==='paperStake')!;h.publish(1,{paper:0n,staked:amount('2450'),queueRevision:1n,outcomes:[{id:i.id,outcome:'succeeded'}]});
    await h.tick();assert.equal(h.store.intent(i.id)!.state,'succeeded');
  }finally{await h.shutdown();}
});
test('paused stake, dust below minimum, zero rewards never generate invalid requests',async()=>{
  const h=setup();h.t.disabledActions=['paperStake'];
  try {h.publish(1,{paper:amount('2450')});await h.tick();assert.equal(h.submitted.length,0);h.t.disabledActions=[];h.publish(1,{paper:amount('999')});await h.tick();assert.equal(h.submitted.filter(i=>i.action==='paperStake'||i.action==='paperClaim').length,0);}finally{await h.shutdown();}
});
test('actual claimable USDC is claimed once and remains separate from trading profit',async()=>{
  const h=setup();h.t.disabledActions=['openPosition','closePositions'];
  try {
    h.publish(1,{staked:amount('2450')});h.pending.set(h.ws[1].address,amount('2'));
    await h.tick();assert.equal(h.ws[1].claimedRewards,amount('2'));assert.equal(h.ws[1].available,amount('302'));assert.equal(h.store.totals().netPnl,0n);
    h.fresh(6000);await h.tick();assert.equal(h.submitted.filter(i=>i.action==='paperClaim').length,1);
  }finally{await h.shutdown();}
});
test('trade round cap keeps reward monitoring alive; disabled loss budget remains null',async()=>{
  const h=setup({maxRounds:1});
  try {
    await h.tick();await h.tick();h.fresh(1001,1002501n);await h.tick();h.fresh();await h.tick();
    assert.equal(h.config.maxNetLossUsdc,null);assert.equal(h.store.get('tradeStoppedReason'),'损耗或轮数限制');assert.equal(h.store.get('stopRequested'),false);
    h.pending.set(h.ws[1].address,amount('1'));h.fresh(6000);await h.tick();assert.equal(h.ws[1].claimedRewards,amount('1'));assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{await h.shutdown();}
});
test('LP queue pauses new opens but still stakes existing PAPER',async()=>{
  const h=setup();h.p.queue=amount('500');
  try {h.publish(1,{paper:amount('2450')});await h.tick();assert.equal(h.submitted.filter(i=>i.action==='paperStake').length,1);assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,0);}finally{await h.shutdown();}
});
test('explicit stop prevents new stake or claim; no automatic withdrawal action exists',async()=>{
  const h=setup();
  try {h.engine.requestStop();h.publish(1,{paper:amount('2450'),staked:amount('1000')});h.pending.set(h.ws[1].address,amount('20'));assert.equal(await h.engine.tick(),'stop');await h.engine.rewards.drain();assert.equal(h.submitted.length,0);}finally{await h.shutdown();}
});
test('acknowledged stake can reconcile after reconnect from queue revision plus staking effect',async()=>{
  const h=setup();
  try {
    h.publish(1,{paper:amount('2450')});h.hook=i=>{if(i.action!=='paperStake')h.auto(i);};
    await h.tick();const i=h.submitted.find(i=>i.action==='paperStake')!;assert.equal(h.store.intent(i.id)!.state,'queued');
    h.publish(1,{paper:0n,staked:amount('2450'),queueRevision:1n});await h.tick();assert.equal(h.store.intent(i.id)!.state,'succeeded');
    assert.equal(h.submitted.filter(i=>i.action==='paperStake').length,1);
  }finally{await h.shutdown();}
});
test('unknown claim is not signed again until its exact outcome is known',async()=>{
  const h=setup();h.t.disabledActions=['openPosition','closePositions'];
  try {
    h.publish(1,{staked:amount('2450')});h.pending.set(h.ws[1].address,amount('2'));h.hook=i=>{if(i.action==='paperClaim')throw new Error('lost response');h.auto(i);};
    await h.tick();h.fresh(10000);await h.tick();const claims=h.submitted.filter(i=>i.action==='paperClaim');assert.equal(claims.length,1);
    h.auto(claims[0]!);await h.tick();assert.equal(h.store.intent(claims[0]!.id)!.state,'succeeded');assert.equal(h.ws[1].claimedRewards,amount('2'));
  }finally{await h.shutdown();}
});
test('restart resumes the exact prepared stake and uses no trading session in rewards-only mode',async()=>{
  const h=setup({rewardsOnly:true});
  try {
    h.publish(1,{paper:amount('2450')});h.hook=i=>{if(i.action==='paperStake')throw new Error('network lost');h.auto(i);};
    await h.tick();const i=h.submitted.find(i=>i.action==='paperStake')!;h.store.updateIntent(i.id,'prepared');
    await h.engine.rewards.shutdown();h.engine=h.restart(true);h.hook=null;await h.tick();
    const staking=h.submitted.filter(i=>i.action==='paperStake');assert.equal(staking.length,2);assert.equal(staking[0]!.id,staking[1]!.id);
    assert.equal(h.ws[1].staked,amount('2450'));assert(!h.submitted.some(i=>i.action==='openPosition'||i.action==='registerSessionKey'));
  }finally{await h.shutdown();}
});
test('claimed rewards are reserved instead of silently funding another round',async()=>{
  const h=setup({reserveClaimedRewards:true});h.t.disabledActions=['openPosition','closePositions'];
  try {
    h.publish(1,{staked:amount('2450'),balance:amount('195'),available:amount('195')});h.pending.set(h.ws[1].address,amount('10'));
    await h.tick();assert.equal(h.ws[1].available,amount('205'));assert.equal(h.store.get<{reserved:bigint}>(`rewardReserve:${h.ws[1].address}`)!.reserved,amount('10'));
    h.t.disabledActions=[];h.fresh();await h.tick();assert(!h.submitted.some(i=>i.action==='openPosition'));
    h.publish(1,{withdrawn:amount('10'),available:amount('195'),balance:amount('195')});assert.equal(h.store.get<{reserved:bigint}>(`rewardReserve:${h.ws[1].address}`)!.reserved,0n);
  }finally{await h.shutdown();}
});

test('LP regression immediately blocks opens until a valid high-water snapshot is restored',async()=>{
  const h=setup({autoStake:false,autoClaim:false});
  try {
    h.t.disabledActions=['openPosition'];await h.tick();h.fresh();h.p.block=99;h.t.disabledActions=[];await h.tick();
    assert.equal(h.submitted.length,0);assert.equal(h.store.get<{healthy:boolean}>('protocolHealth')?.healthy,false);
    h.p.block=100;h.fresh();await h.tick();assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{await h.shutdown();}
});
test('completed expired rounds do not consume nonce RPC capacity during an active hedged round',async()=>{
  const h=setup({openTimeoutMs:null,autoStake:false,autoClaim:false});let reads=0;
  try {
    const a=('0x'+'a'.repeat(64)) as `0x${string}`,b=('0x'+'b'.repeat(64)) as `0x${string}`;
    const old=h.ws.map((w,index)=>({id:index===0?a:b,wallet:w.address,round:100,action:'openPosition' as const,
      signed:{user:w.address,instrumentId:'0',isLong:index===0,size:String(amount('200')),leverage:'50',useDebt:false,nonce:String(index+9)},
      state:'expired' as const,deadline:NOW/1000-1,createdAt:NOW-100000,ackRevision:null}));
    h.store.transaction(()=>{
      h.store.saveRound({id:100,state:'complete',createdAt:NOW-100000,reason:'old expired requests',legs:old.map(i=>({wallet:i.wallet,openIntent:i.id,position:null,closeIntent:null,settled:null})) as [
        {wallet:Address;openIntent:`0x${string}`;position:null;closeIntent:null;settled:null},
        {wallet:Address;openIntent:`0x${string}`;position:null;closeIntent:null;settled:null}
      ]});
      for(const i of old)h.store.prepare(i);
    });
    h.api.nonceUsed=async()=>{reads++;return false;};
    await h.tick();await h.tick();await h.engine.drainBackground();
    assert.equal(h.store.activeRound()?.state,'hedged');assert.equal(reads,0);
  }finally{await h.shutdown();}
});
test('a stalled market refresh does not block an already-triggered close',async()=>{
  const h=setup({autoStake:false,autoClaim:false});let release:((t:ReturnType<typeof trading>)=>void)|undefined;
  try {
    await h.tick();await h.tick();h.api.trading=()=>new Promise(r=>{release=r;});h.fresh(1001,1002501n);
    await h.tick();assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,2);
    assert.equal(h.store.activeRound(),null);
  }finally{release?.(h.t);await h.shutdown();}
});
test('healthy wallet stakes independently even when the other wallet has no snapshot',async()=>{
  const h=setup();
  try {
    h.sources.get(h.ws[0].address)!.current=false;h.sources.get(h.ws[0].address)!.latest=null;
    h.publish(1,{paper:amount('2450')});await h.tick();
    assert.equal(h.submitted.filter(i=>i.action==='paperStake').length,1);assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,0);
  }finally{await h.shutdown();}
});
test('lost staking receipt reconciles from indexed nonce plus staking effect and allows claim',async()=>{
  const h=setup({rewardsOnly:true});
  try {
    h.publish(1,{paper:amount('2450')});h.hook=i=>{if(i.action==='paperStake')throw new Error('lost response');h.auto(i);};
    await h.tick();const stake=h.submitted.find(i=>i.action==='paperStake')!;
    h.api.nonceUsed=async()=>false;h.publish(1,{paper:0n,staked:amount('2450'),queueRevision:2n});h.pending.set(h.ws[1].address,amount('2'));
    await h.tick();await h.engine.drainBackground();assert.equal(h.store.intent(stake.id)?.state,'unknown');
    h.fresh(6000);h.api.nonceUsed=async()=>true;await h.tick();await h.engine.drainBackground();await h.engine.rewards.drain();
    assert.equal(h.store.intent(stake.id)?.state,'succeeded');assert.equal(h.submitted.filter(i=>i.action==='paperStake').length,1);
    assert.equal(h.ws[1].claimedRewards,amount('2'));
  }finally{await h.shutdown();}
});
test('unknown close is never cancelled and renewal waits for indexed expiry',async()=>{
  const h=setup({autoStake:false,autoClaim:false});let cancels=0;
  try {
    await h.tick();await h.tick();h.fresh(1001,1002501n);
    h.hook=i=>{if(i.action==='closePositions'&&i.wallet===h.ws[0].address)throw new Error('timeout');h.auto(i);};
    await h.tick();await h.engine.drainBackground();const old=h.submitted.find(i=>i.action==='closePositions'&&i.wallet===h.ws[0].address)!;
    assert.equal(old.deadline-Math.floor(h.now/1000),60);
    h.api.cancel=async()=>{cancels++;return 'cancelled';};
    h.fresh(60000);await h.tick();await h.engine.drainBackground();
    assert.equal(h.store.intent(old.id)?.state,'unknown');assert.equal(cancels,0);
    assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,2);
    h.fresh(1001);h.publish(0,{});h.hook=null;await h.tick();
    assert.equal(h.store.intent(old.id)?.state,'expired');assert.equal(cancels,0);
    assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,3);assert.equal(h.store.activeRound(),null);
  }finally{await h.shutdown();}
});
test('missing open snapshot queries history but never guesses ownership from matching size or direction',async()=>{
  const h=setup({autoStake:false,autoClaim:false});let reads=0;
  try {
    h.hook=()=>{};await h.tick();const r=h.store.activeRound()!,leg=r.legs[0];
    const closed={id:'123',instrumentId:0,isLong:true,margin:amount('200'),leverage:50,liquidated:true,netPnl:-amount('200'),paper:amount('19600')};
    h.api.history=async(w)=>{reads++;return w===leg.wallet?[closed]:[];};h.publish(0,{realizedPnl:closed.netPnl,closed:[closed]});
    h.fresh(31001);await h.tick();await h.engine.drainBackground();assert(reads>0);assert.equal(h.store.totals().positions,0);assert(h.store.get('unresolvedOwnership'));
    h.api.history=async(w)=>w===leg.wallet?[{...closed,openIntentId:leg.openIntent}]:[];
    h.fresh(6000);await h.tick();await h.engine.drainBackground();assert.equal(h.store.totals().positions,1);assert.equal(h.store.get('unresolvedOwnership'),null);
  }finally{await h.shutdown();}
});

test('unlimited empty queue wait accepts both fills after the old 30-second cutoff',async()=>{
  const h=setup({openTimeoutMs:null,autoStake:false,autoClaim:false});
  try {
    h.hook=()=>{};await h.tick();const opens=h.submitted.filter(i=>i.action==='openPosition');
    assert.equal(opens[0]!.deadline-Math.floor(NOW/1000),300);
    h.fresh(65000);await h.tick();assert.equal(h.store.activeRound()?.state,'opening');assert.equal(h.engine.failureReason,null);assert.equal(h.submitted.length,2);
    h.fill(opens[0]!);h.fill(opens[1]!);await h.tick();assert.equal(h.store.activeRound()?.state,'hedged');assert.equal(h.submitted.length,2);
  }finally{await h.shutdown();}
});
test('partial fill timer starts at the first fill, not initial queue admission',async()=>{
  const h=setup({openTimeoutMs:null,autoStake:false,autoClaim:false});
  try {
    h.hook=i=>{if(i.action!=='openPosition')h.auto(i);};await h.tick();const first=h.submitted.find(i=>i.action==='openPosition')!;
    h.fresh(60000);h.fill(first);await h.tick();assert.equal(h.store.activeRound()?.state,'opening');
    assert.equal(h.store.activeRound()?.firstFillAt,h.now);
    h.fresh(29000);await h.tick();assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,0);
    h.fresh(1001);await h.tick();assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,1);assert.match(h.engine.failureReason!,/单边开仓等待对冲超时/);
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{await h.shutdown();}
});
test('expired empty opens wait for unused-nonce proof before renewing with fresh requests',async()=>{
  const h=setup({openTimeoutMs:null,autoStake:false,autoClaim:false});const releases:Array<(used:boolean)=>void>=[];
  try {
    h.hook=()=>{};await h.tick();const opens=h.submitted.filter(i=>i.action==='openPosition');
    h.fresh(301000);h.p.block=200;
    h.publish(0,{block:200,outcomes:[{id:opens[0]!.id,outcome:'expired'}]});h.publish(1,{block:200,outcomes:[{id:opens[1]!.id,outcome:'expired'}]});
    h.api.nonceUsed=()=>new Promise(resolve=>releases.push(resolve));await h.tick();
    assert.equal(h.store.activeRound()?.state,'opening');assert.equal(h.submitted.length,2);
    for(const release of releases)release(false);await h.engine.drainBackground();await h.tick();
    assert.equal(h.store.activeRound(),null);assert.equal(h.engine.failureReason,null);
    h.hook=null;h.fresh(1001);await h.tick();assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,4);
    assert.notEqual(h.submitted[2]!.id,opens[0]!.id);assert.notEqual(h.submitted[2]!.signed.nonce,opens[0]!.signed.nonce);
  }finally{for(const release of releases)release(false);await h.shutdown();}
});
test('a spent opening nonce with missing ownership never enters the empty-order retry path',async()=>{
  const h=setup({openTimeoutMs:null,autoStake:false,autoClaim:false});
  try {
    h.hook=()=>{};await h.tick();const opens=h.submitted.filter(i=>i.action==='openPosition');h.fresh(301000);
    h.api.nonceUsed=async()=>true;
    h.publish(0,{outcomes:[{id:opens[0]!.id,outcome:'expired'}]});h.publish(1,{outcomes:[{id:opens[1]!.id,outcome:'expired'}]});
    await h.tick();await h.engine.drainBackground();await h.tick();
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);assert.match(h.engine.failureReason!,/nonce 已使用/);
    assert.equal(h.store.activeRound()?.state,'recovering');assert(h.store.get('unresolvedOwnership'));
  }finally{await h.shutdown();}
});
test('explicit stop still cancels empty queued orders in unlimited-wait mode',async()=>{
  const h=setup({openTimeoutMs:null,autoStake:false,autoClaim:false});
  try {
    h.hook=()=>{};h.api.cancel=async()=> 'cancelled';await h.tick();h.fresh(45000);await h.tick();
    h.engine.requestStop();await h.tick();await h.engine.drainBackground();assert.equal(await h.engine.tick(),'stop');
    assert.equal(h.submitted.filter(i=>i.action==='openPosition').length,2);assert.equal(h.store.activeRound(),null);
  }finally{await h.shutdown();}
});

test('queued closes are neither cancelled nor duplicated after a long wait, even on stop',async()=>{
  const h=setup({autoStake:false,autoClaim:false});let cancels=0;
  try {
    await h.tick();await h.tick();h.hook=()=>{};h.fresh(1001,1002501n);await h.tick();await h.engine.drainBackground();
    const closes=h.submitted.filter(i=>i.action==='closePositions');assert.equal(closes.length,2);
    h.api.cancel=async()=>{cancels++;return 'cancelled';};
    for(const [idx,i] of closes.entries())h.publish(idx,{operations:[{id:i.id,action:i.action,deadline:BigInt(i.deadline),positionIds:i.signed.positionIds as string[]}]});
    h.fresh(180000);h.publish(0,{});h.publish(1,{});await h.tick();
    assert(closes.every(i=>h.store.intent(i.id)?.state==='queued'));assert.equal(cancels,0);
    h.engine.requestStop();await h.tick();await h.engine.drainBackground();
    assert.equal(cancels,0);assert.equal(h.submitted.filter(i=>i.action==='closePositions').length,2);assert(h.store.activeRound());
  }finally{await h.shutdown();}
});
