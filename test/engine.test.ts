import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError, type TradingApi } from '../src/api.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { decryptSession, encryptSession, signIntent } from '../src/signing.js';
import type { Intent, Position, Receipt, Signed, Wallet } from '../src/types.js';
import type { QuoteSource, WalletSource } from '../src/streams.js';
import { netPnl } from '../src/math.js';
import { amount } from '../src/util.js';
import { config, identities, installSessions, market, NOW, position, protocol, trading, wallet } from './fixtures.js';

class FakeApi implements TradingApi {
  t=trading();p=protocol();submitted:Intent[]=[];cancelled:Hex[]=[];
  onSubmit:((i:Intent)=>Promise<void>|void)|undefined;
  onCancel:((id:Hex)=>'pending'|'cancelled')|undefined;
  historyRows=new Map<Address,ReturnType<TradingApi['history']> extends Promise<infer T>?T:never>();
  trading=async()=>this.t;protocol=async()=>this.p;
  pendingReward=async()=>0n;
  async submit(i:Intent):Promise<Receipt> {this.submitted.push(i);await this.onSubmit?.(i);return{intentId:i.id,action:i.action,state:'queued',queueRevision:1n};}
  async cancel(id:Hex,_signed:Signed) {this.cancelled.push(id);return this.onCancel?.(id)??'pending';}
  history=async(wallet:Address)=>this.historyRows.get(wallet)??[];
}
function harness(sessions=true) {
  const dir=mkdtempSync(join(tmpdir(),'papertrade-engine-')),store=new Store(dir),ids=identities(),api=new FakeApi();
  const h={dir,store,ids,api,now:NOW,ws:[wallet(),wallet(1)] as [Wallet,Wallet],engine:null as unknown as Engine,
    quotes:{latest:{bid:1000000n,ask:1000000n,mid:1000000n,time:NOW,receivedAt:NOW},start(){},stop(){}} as QuoteSource,
    sources:new Map<Address,WalletSource>(),
    publish(index:number,patch:Partial<Wallet>) {
      const w={...h.ws[index]!,revision:h.ws[index]!.revision+1,timestamp:Math.floor(h.now/1000),closed:[],outcomes:[],...patch};h.ws[index]=w;
      h.sources.get(w.address)!.latest=w;h.engine.observe(w);
    },
    fill(i:Intent) {
      const index=ids.findIndex(a=>a.address===i.wallet),p:Position={...position(index===0,String(index+1)),intentId:i.id,margin:BigInt(String(i.signed.size)),leverage:Number(i.signed.leverage)};
      h.publish(index,{positions:[p],locked:p.margin,balance:h.ws[index]!.balance-p.margin,available:h.ws[index]!.available-p.margin,outcomes:[{id:i.id,outcome:'succeeded'}]});
    },
    settle(i:Intent) {
      const index=ids.findIndex(a=>a.address===i.wallet),w=h.ws[index]!,p=w.positions.find(p=>(i.signed.positionIds as string[]).includes(p.id))!;
      const pnl=netPnl(p,h.quotes.latest!.mid,market()),closed={id:p.id,instrumentId:0,isLong:p.isLong,margin:p.margin,leverage:p.leverage,liquidated:false,netPnl:pnl,paper:pnl<0n?-pnl*98n:0n};
      const returned=p.margin+(pnl<0n?pnl:0n);h.publish(index,{positions:[],locked:0n,balance:w.balance+returned,available:w.available+returned,queued:w.queued+(pnl>0n?pnl:0n),realizedPnl:w.realizedPnl+pnl,closed:[closed],outcomes:[{id:i.id,outcome:'succeeded'}]});
    },
    auto(i:Intent) {if(i.action==='openPosition')h.fill(i);else if(i.action==='closePositions')h.settle(i);else{const index=ids.findIndex(a=>a.address===i.wallet);h.publish(index,{sessions:{...h.ws[index]!.sessions,[String(i.signed.key)]:BigInt(String(i.signed.expiry))},outcomes:[{id:i.id,outcome:'succeeded'}]});}},
    fresh(ms=0,price?:bigint) {h.now+=ms;if(h.quotes.latest)h.quotes.latest={...h.quotes.latest,time:h.now,receivedAt:h.now,...price===undefined?{}:{mid:price,bid:price,ask:price}};},
    tick:()=>h.engine.tick(),
    close() {store.close();rmSync(dir,{recursive:true,force:true});}
  };
  for(const w of h.ws)h.sources.set(w.address,{latest:w,current:true,start(){},stop(){}});
  if(sessions)installSessions(store,h.ws);
  h.engine=new Engine({...config(),stateDir:dir},ids,store,api,{now:()=>h.now,sources:h.sources,quotes:h.quotes});
  for(const w of h.ws)h.engine.observe(w);api.onSubmit=i=>h.auto(i);return h;
}
test('scheduled run waits, checks early, and opens only after time and official admission allow',async()=>{
  const h=harness(false),at=NOW+10000;h.engine.config.openingAtUtc=new Date(at).toISOString();
  let reads=0;h.api.trading=async()=>{reads++;return h.api.t;};
  try {
    await h.tick();assert.equal(reads,0);assert.equal(h.api.submitted.length,0);
    h.fresh(7000);h.api.t.disabledActions=['openPosition'];await h.tick();
    assert.equal(reads,1);assert.equal(h.api.submitted.filter(i=>i.action==='registerSessionKey').length,2);
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,0);
    h.fresh(2999);h.api.t.disabledActions=[];await h.tick();
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,0);
    h.fresh(1);h.api.t.disabledActions=['openPosition'];await h.tick();
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,0);
    h.fresh(1000);h.api.t.disabledActions=[];await h.tick();
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{h.close();}
});
test('a state request started before opening cannot authorize new trading even if it completes afterwards',async()=>{
  const h=harness(),at=NOW+1000;h.engine.config.openingAtUtc=new Date(at).toISOString();
  h.api.trading=async()=>{h.fresh(1000);return h.api.t;};
  try {
    await h.tick();assert.equal(h.api.submitted.length,0);
    await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{h.close();}
});
test('launch schedule never delays closing inventory or explicit stopping',async()=>{
  const h=harness();
  try {
    await h.tick();await h.tick();h.engine.config.openingAtUtc=new Date(NOW+86400000).toISOString();
    h.fresh(1000,1010001n);await h.tick();
    assert.equal(h.store.activeRound(),null);assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,2);
    h.engine.requestStop();assert.equal(await h.tick(),'stop');
  }finally{h.close();}
});
test('both explicitly unfilled transient rejections retry only after Retry-After and fresh checks',async()=>{
  const h=harness();
  try {
    h.api.onSubmit=()=>{throw new ApiError(429,'rate_limited',true,5000);};
    await h.tick();await h.tick();assert.equal(h.store.activeRound(),null);assert.equal(h.engine.failureReason,null);
    h.fresh(4999);await h.tick();assert.equal(h.api.submitted.length,2);
    h.fresh(1);h.api.onSubmit=i=>h.auto(i);await h.tick();
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,4);
  }finally{h.close();}
});
test('unknown open results never take the transient admission retry path',async()=>{
  const h=harness();
  try {
    h.api.onSubmit=()=>{throw new Error('timeout');};await h.tick();h.fresh(1000);await h.tick();
    assert.equal(h.api.submitted.length,2);assert.equal(h.store.activeRound()?.state,'opening');
    assert.equal(h.store.get('nextOpenAttemptAt'),null);
  }finally{h.close();}
});
test('definitively failed closes honor Retry-After before allocating replacement close intents',async()=>{
  const h=harness();
  try {
    await h.tick();await h.tick();
    h.api.onSubmit=i=>{if(i.action==='closePositions')throw new ApiError(429,'rate_limited',true,20000);h.auto(i);};
    h.fresh(1000,1010001n);await h.tick();
    h.fresh(19999);await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,2);
    h.fresh(1);h.api.onSubmit=i=>h.auto(i);await h.tick();
    assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,4);assert.equal(h.store.activeRound(),null);
  }finally{h.close();}
});
test('end-to-end parallel pair, exact threshold, queued profit, ledger and round limit',async()=>{
  const h=harness();h.engine.config.maxRounds=1;
  try {
    await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,2);
    await h.tick();assert.equal(h.store.activeRound()?.state,'hedged');
    h.fresh(1000,1010000n);await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,0);
    h.fresh(1000,1010001n);await h.tick();assert.equal(h.store.activeRound(),null);
    assert.equal(h.store.totals().positions,2);assert(h.store.totals().netPnl<0n);assert(h.ws[0].queued>0n);
    assert.equal(await h.tick(),'stop');assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,2);
    assert(h.api.submitted.filter(i=>i.action==='openPosition').every(i=>i.signed.useDebt===false));
  }finally{h.close();}
});
test('a rejected sibling forces a compensating close, never a replacement open',async()=>{
  const h=harness();
  try {
    h.api.onSubmit=i=>{if(i.action==='openPosition'&&i.wallet===h.ids[0].address)throw new ApiError(422,'admission_rejected',true);h.auto(i);};
    await h.tick();await h.tick();assert.equal(h.store.activeRound(),null);
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,2);
    assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,1);assert(h.engine.failureReason);
  }finally{h.close();}
});
test('unknown sibling can fill after cancel attempt; only its tracked position is flattened',async()=>{
  const h=harness();
  try {
    h.api.onSubmit=i=>{if(i.action==='openPosition'){if(i.wallet===h.ids[0].address)throw new ApiError(422,'admission_rejected',true);throw new Error('lost acknowledgement');}h.auto(i);};
    await h.tick();await h.tick();assert.equal(h.store.activeRound()?.state,'recovering');assert.equal(h.api.cancelled.length,1);
    const late=h.api.submitted.find(i=>i.action==='openPosition'&&i.wallet===h.ids[1].address)!;h.fill(late);
    await h.tick();assert.equal(h.store.activeRound(),null);
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,2);assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,1);
  }finally{h.close();}
});
test('unknown close acknowledgement does not allocate another nonce or double close',async()=>{
  const h=harness();
  try {
    await h.tick();await h.tick();h.api.onSubmit=i=>{if(i.action==='closePositions')throw new Error('timeout');h.auto(i);};
    h.fresh(1000,1010001n);await h.tick();const closes=h.api.submitted.filter(i=>i.action==='closePositions');assert.equal(closes.length,2);
    h.fresh(16000);await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,2);assert.equal(h.api.cancelled.length,0);
    h.settle(closes[0]!);h.settle(closes[1]!);await h.tick();assert.equal(h.store.activeRound(),null);
  }finally{h.close();}
});
test('lost heartbeat/quote stops new opens and exits known inventory',async()=>{
  const h=harness();
  try {await h.tick();await h.tick();h.now+=6000;await h.tick();assert.equal(h.store.activeRound()?.state,'hedged');
    h.now+=16000;await h.tick();assert.equal(h.store.activeRound(),null);assert.match(h.engine.failureReason!,/中断/);assert.equal(h.api.submitted.filter(i=>i.action==='closePositions').length,2);}finally{h.close();}
});
test('manual positions are never closed or adopted',async()=>{
  const h=harness();
  try {h.publish(0,{positions:[position(true,'999')],locked:amount('500')});assert.equal(await h.tick(),'stop');assert.equal(h.api.submitted.length,0);}finally{h.close();}
});
test('automatic session registration needs no browser, and pause forbids trading',async()=>{
  const h=harness(false);h.api.t.disabledActions=['openPosition','closePositions'];
  try {await h.tick();await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='registerSessionKey').length,2);assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,0);}finally{h.close();}
});
test('session renewal retains the old key until the candidate is authorized',async()=>{
  const h=harness();
  try {
    for(const [idx,id] of h.ids.entries()) {const raw=h.store.get<string>(`session:active:${id.address}`)!;const s=decryptSession(raw,id);s.expiry=NOW/1000+1000;const {encryptSession}=await import('../src/signing.js');h.store.set(`session:active:${id.address}`,encryptSession(s,id));h.ws[idx]!.sessions[s.address]=BigInt(s.expiry);}
    h.api.onSubmit=()=>{};await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='registerSessionKey').length,2);
    assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,0);
    await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='registerSessionKey').length,2);
  }finally{h.close();}
});
test('a crash after preparing a close resumes the exact request',async()=>{
  const h=harness();
  try {
    await h.tick();await h.tick();const r=h.store.activeRound()!,w=h.ws[0],s=decryptSession(h.store.get<string>(`session:active:${w.address}`)!,h.ids[0]);
    const deadline=NOW/1000+3600,signed=await signIntent(privateKeyToAccount(s.privateKey),'Close',{user:w.address,positionIds:[BigInt(r.legs[0].position!.id)],nonce:h.store.nonce(w.address),deadline:BigInt(deadline)});
    const i:Intent={id:signed.id,wallet:w.address,round:r.id,action:'closePositions',signed:signed.signed,state:'prepared',deadline,createdAt:NOW,ackRevision:null};
    r.state='closing';r.legs[0].closeIntent=i.id;h.store.transaction(()=>{h.store.prepare(i);h.store.saveRound(r);});
    h.engine=new Engine({...config(),stateDir:h.dir},h.ids,h.store,h.api,{now:()=>h.now,sources:h.sources,quotes:h.quotes});
    await h.tick();assert(h.api.submitted.some(x=>x.id===i.id));assert.equal(h.store.activeRound(),null);
  }finally{h.close();}
});
test('downward move and in-position loss budget trigger both close',async()=>{
  const h=harness();
  try {await h.tick();await h.tick();h.engine.config.maxNetLossUsdc='1';h.fresh(1000,995000n);await h.tick();assert.equal(h.store.activeRound(),null);assert.match(h.engine.failureReason!,/净损耗/);}finally{h.close();}
});
test('restart does not submit an unattempted missing hedge',async()=>{
  const h=harness();
  try {
    await h.tick();const r=h.store.activeRound()!; // Simulate one HTTP boundary not being crossed at crash.
    h.store.updateIntent(r.legs[0].openIntent,'prepared');h.publish(0,{positions:[],locked:0n,balance:amount('1000'),available:amount('1000')});
    h.engine=new Engine({...config(),stateDir:h.dir},h.ids,h.store,h.api,{now:()=>h.now,sources:h.sources,quotes:h.quotes});
    await h.tick();assert.equal(h.api.submitted.filter(i=>i.action==='openPosition').length,2);
  }finally{h.close();}
});
test('settlements missed during SSE reconnect are restored from owned-position history',async()=>{
  const h=harness();
  try {
    await h.tick();await h.tick();
    h.api.onSubmit=i=>{
      if(i.action!=='closePositions'){h.auto(i);return;}
      const index=h.ids.findIndex(a=>a.address===i.wallet),w=h.ws[index]!,p=w.positions[0]!,pnl=netPnl(p,h.quotes.latest!.mid,market());
      const closed={id:p.id,instrumentId:0,isLong:p.isLong,margin:p.margin,leverage:p.leverage,liquidated:false,netPnl:pnl,paper:pnl<0n?-pnl*98n:0n};
      h.api.historyRows.set(w.address,[closed]);const returned=p.margin+(pnl<0n?pnl:0n);
      h.publish(index,{positions:[],locked:0n,balance:w.balance+returned,available:w.available+returned,queued:w.queued+(pnl>0n?pnl:0n),realizedPnl:w.realizedPnl+pnl,closed:[],outcomes:[]});
    };
    h.fresh(1000,1010001n);await h.tick();assert.equal(h.store.totals().positions,0);
    await h.tick();assert.equal(h.store.activeRound(),null);assert.equal(h.store.totals().positions,2);
    await h.tick();assert.equal(h.store.totals().positions,2);
  }finally{h.close();}
});
test('failed session renewal flattens before the old authorization expires',async()=>{
  const h=harness();
  try {
    await h.tick();await h.tick();
    for(const [index,id] of h.ids.entries()) {
      const s=decryptSession(h.store.get<string>(`session:active:${id.address}`)!,id);s.expiry=NOW/1000+120;
      h.store.set(`session:active:${id.address}`,encryptSession(s,id));h.ws[index]!.sessions[s.address]=BigInt(s.expiry);
    }
    h.api.onSubmit=i=>{if(i.action!=='registerSessionKey')h.auto(i);};
    await h.tick();assert.equal(h.store.activeRound(),null);assert.match(h.engine.failureReason!,/旧授权/);
    for(const i of h.api.submitted.filter(i=>i.action==='closePositions'))assert(Number(i.signed.deadline)<NOW/1000+120);
  }finally{h.close();}
});
