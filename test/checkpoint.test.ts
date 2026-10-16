import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { readCheckpoint } from '../src/checkpoint.js';
import { configSchema } from '../src/config.js';
import { decideStrategy } from '../src/strategy.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Intent, Receipt, Round, Wallet } from '../src/types.js';
import type { TradingApi } from '../src/api.js';
import type { QuoteSource, WalletSource } from '../src/streams.js';
import { identities, installSessions, market, NOW, position, protocol, trading, wallet } from './fixtures.js';
import { amount } from '../src/util.js';

const ids=identities(),id=(letter:string)=>('0x'+letter.repeat(64)) as Hex;
const config=()=>configSchema.parse({marginUsdc:'500',leverage:20,openTimeoutMs:null,keepRewardsMonitoring:true});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'papertrade-checkpoint-')),store=new Store(dir);
  store.bind(ids.map(x=>x.address),'BTC');
  const ws=[wallet(),wallet(1)] as [Wallet,Wallet];
  installSessions(store,ws);for(const w of ws)store.snapshot(w);
  const first:Intent={id:id('a'),wallet:ids[0].address,round:1,action:'openPosition',signed:{user:ids[0].address,instrumentId:'0',isLong:true,size:String(amount('500')),leverage:'20',nonce:'41',r:'DO_NOT_PRINT_SIGNATURE'},state:'queued',deadline:NOW/1000+300,createdAt:NOW,ackRevision:'1'};
  const second:Intent={...first,id:id('b'),wallet:ids[1].address,signed:{...first.signed,user:ids[1].address,isLong:false,nonce:'42'},state:'unknown'};
  const round:Round={id:1,state:'opening',createdAt:NOW,reason:null,legs:[{wallet:first.wallet,openIntent:first.id,position:null,closeIntent:null,settled:null},{wallet:second.wallet,openIntent:second.id,position:null,closeIntent:null,settled:null}]};
  store.transaction(()=>{store.saveRound(round);store.prepare(first);store.prepare(second);});
  const sources=new Map<Address,WalletSource>(ids.map((x,index)=>[x.address,{latest:ws[index]!,current:true,start(){},stop(){}}]));
  const quotes:QuoteSource={latest:{bid:1_000_000n,ask:1_000_000n,mid:1_000_000n,time:NOW,receivedAt:NOW},start(){},stop(){}};
  let financialCalls=0;
  const api:TradingApi={trading:async()=>trading(),protocol:async()=>protocol(),history:async()=>[],pendingReward:async()=>0n,cancel:async()=> 'pending',submit:async(_i:Intent):Promise<Receipt>=>{financialCalls++;throw new Error('unexpected financial request');}};
  return {dir,store,ws,first,second,round,sources,quotes,api,get financialCalls(){return financialCalls;},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('read-only checkpoint shows durable positions and intents but no signed payloads or cached session secrets',()=>{
  const h=fixture();
  try {
    h.store.set(`session:candidate:${h.first.wallet}`,'DO_NOT_PRINT_CACHED_SESSION');
    const before=readFileSync(h.store.path);
    const reader=new Store(h.dir,true);
    let data:ReturnType<typeof readCheckpoint>;
    try{data=readCheckpoint(reader,NOW);}finally{reader.close();}
    assert.deepEqual(readFileSync(h.store.path),before);
    assert.equal(data.nextAction,'resume_existing_open_requests');assert.equal(data.activeRound?.state,'opening');
    assert.equal(data.pendingIntents.length,2);assert.deepEqual(data.integrityErrors,[]);
    assert.equal(data.sessionCache.find(x=>x.wallet===h.first.wallet)?.candidate,true);
    assert(!JSON.stringify(data).includes('DO_NOT_PRINT_SIGNATURE'));
    assert(!JSON.stringify(data).includes('DO_NOT_PRINT_CACHED_SESSION'));
  }finally{h.close();}
});

test('checkpoint CLI reads state without private-key environment variables or financial API calls',()=>{
  const h=fixture();
  try {
    const output=execFileSync(process.execPath,['--import','tsx','src/cli.ts','checkpoint','--state-dir',h.dir],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,PAPERTRADE_WALLET_A_PRIVATE_KEY:'',PAPERTRADE_WALLET_B_PRIVATE_KEY:''}});
    const data=JSON.parse(output) as ReturnType<typeof readCheckpoint>;
    assert.equal(data.nextAction,'resume_existing_open_requests');assert.equal(data.pendingIntents.length,2);
    assert(!output.includes('DO_NOT_PRINT_SIGNATURE'));assert.equal(h.financialCalls,0);
  }finally{h.close();}
});

test('restart reads two already submitted opening requests without resending or replacing their nonces',async()=>{
  const h=fixture();
  try {
    const engine=new Engine(config(),ids,h.store,h.api,{now:()=>NOW,sources:h.sources,quotes:h.quotes});
    await engine.tick();await engine.drainBackground();
    assert.equal(h.financialCalls,0);assert.equal(h.store.activeRound()?.id,1);
    assert.equal(h.store.intent(h.first.id)?.state,'queued');assert.equal(h.store.intent(h.second.id)?.state,'unknown');
    assert.equal(h.store.get<{nextAction:string}>('checkpointStartup')?.nextAction,'resume_existing_open_requests');
    assert.equal(h.store.get<{phase:string;outstandingSavedRequests:number}>('runtimeCheckpoint')?.outstandingSavedRequests,2);
  }finally{h.close();}
});

test('restart preserves an existing hedged round and its original close threshold',async()=>{
  const h=fixture();
  try {
    const positions=[{...position(true,'1'),intentId:h.first.id},{...position(false,'2'),intentId:h.second.id}];
    h.round.state='hedged';h.round.legs[0]!.position=positions[0]!;h.round.legs[1]!.position=positions[1]!;
    h.round.strategy=decideStrategy(config(),trading(),market(),protocol(),h.ws,NOW);
    for(const [index,p] of positions.entries()){
      const w=h.ws[index]!;w.positions=[p];w.locked=p.margin;w.available-=p.margin;w.balance-=p.margin;h.store.snapshot(w);
      h.store.updateIntent(index===0?h.first.id:h.second.id,'succeeded');
    }
    h.store.saveRound(h.round);
    const altered=configSchema.parse({marginUsdc:'500',leverage:20,closeMoveBps:25,openTimeoutMs:null,keepRewardsMonitoring:true});
    const engine=new Engine(altered,ids,h.store,h.api,{now:()=>NOW,sources:h.sources,quotes:h.quotes});
    await engine.tick();await engine.drainBackground();
    assert.equal(h.financialCalls,0);assert.equal(h.store.activeRound()?.strategy?.closeMoveBps,100);
    assert.equal(h.store.activeRound()?.state,'hedged');
    assert.equal(h.store.get<{phase:string}>('runtimeCheckpoint')?.phase,'monitoring_saved_hedge');
  }finally{h.close();}
});

test('restart preserves recovery halt and refuses orphaned unfinished intents',()=>{
  const h=fixture();
  try {
    h.round.state='recovering';h.round.reason='存量退出待对账';h.store.saveRound(h.round);
    const engine=new Engine(config(),ids,h.store,h.api,{now:()=>NOW,sources:h.sources,quotes:h.quotes});
    assert.equal(engine.failureReason,null);
    assert.equal(h.store.get('tradeStoppedReason'),'存量退出待对账');
    h.store.updateIntent(h.first.id,'succeeded');h.store.updateIntent(h.second.id,'succeeded');
    h.store.saveRound({...h.round,state:'complete'});
    h.store.prepare({...h.first,id:id('c'),round:999,state:'unknown'});
    assert.match(readCheckpoint(h.store,NOW).integrityErrors.join(';'),/不属于未完成轮次/);
    assert.throws(()=>new Engine(config(),ids,h.store,h.api,{now:()=>NOW,sources:h.sources,quotes:h.quotes}),/断点完整性检查失败/);
  }finally{h.close();}
});

test('restart never sends a leg that was only prepared before the crash',()=>{
  const h=fixture();
  try {
    h.store.updateIntent(h.first.id,'prepared');
    const engine=new Engine(config(),ids,h.store,h.api,{now:()=>NOW,sources:h.sources,quotes:h.quotes});
    assert.equal(h.store.intent(h.first.id)?.state,'cancelled');assert.equal(h.store.activeRound()?.state,'recovering');
    assert.equal(h.financialCalls,0);assert.match(engine.failureReason??'',/从未提交/);
  }finally{h.close();}
});
