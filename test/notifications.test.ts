import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatAmount2, TradeNotifier } from '../src/notifications.js';
import { Store } from '../src/store.js';
import { amount } from '../src/util.js';
import type { TradingApi } from '../src/api.js';
import type { Round } from '../src/types.js';
import { identities, market, wallet } from './fixtures.js';
import { config, trading, protocol } from './fixtures.js';
import { decideStrategy } from '../src/strategy.js';

test('Bark amount formatting rounds signed amounts to exactly two decimals',()=>{
  assert.equal(formatAmount2(0n),'0.00');
  assert.equal(formatAmount2(amount('1.234')),'1.23');
  assert.equal(formatAmount2(amount('1.235')),'1.24');
  assert.equal(formatAmount2(-amount('0.766956585325861167')),'-0.77');
  assert.equal(formatAmount2(-amount('0.004')),'0.00');
});

test('Bark margin warning identifies weak wallet and liquidation buffer, rate-limits repeated state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-margin-bark-')),store=new Store(dir),ids=identities();
  let now=1_000_000,sends=0,body='';
  try {
    store.bind(ids.map(i=>i.address),'BTC');
    const a=wallet(),b=wallet(1);a.available=amount('100');b.available=amount('500');
    store.snapshot(a);store.snapshot(b);
    const cfg={...config(),marginUsdc:'300',leverage:40,closeMoveBps:200,bustHeadroomBps:100};
    const decision=decideStrategy(cfg,trading(),market(),protocol(),[a,b]);
    const api={pendingReward:async()=>0n} as unknown as TradingApi;
    const fetcher=(async(_url:URL|RequestInfo,init?:RequestInit)=>{sends++;body=(JSON.parse(String(init?.body)) as {body:string}).body;return new Response(JSON.stringify({code:200}),{status:200});}) as typeof fetch;
    const notifier=new TradeNotifier(store,api,[a.address,b.address],()=>market(),()=>null,'https://bark.example/test-device/',fetcher,()=>now);
    const reasons=['保证金不足','杠杆过高，无法覆盖 200 bps 目标及强平缓冲'];
    notifier.queueMarginWarning(cfg,decision,market(),[a,b],reasons);await notifier.shutdown();
    notifier.queueMarginWarning(cfg,decision,market(),[a,b],reasons);await notifier.shutdown();
    assert.equal(sends,1);assert.match(body,/钱包 A .*可用 100\.00 USDC/);assert.match(body,/钱包 B .*可用 500\.00 USDC/);
    assert.match(body,/最高安全杠杆/);assert.match(body,/额外强平缓冲：100 bps/);
    assert(!body.includes('test-device'));
    now+=30*60*1000;
    notifier.queueMarginWarning(cfg,decision,market(),[a,b],reasons);await notifier.shutdown();assert.equal(sends,2);
    const funded={...a,available:amount('500')};
    notifier.queueMarginWarning(cfg,decision,market(),[funded,b],['市场方向 OI 安全余量不足']);
    notifier.queueMarginWarning(cfg,decision,market(),[a,b],reasons);await notifier.shutdown();assert.equal(sends,3);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('cash-constrained auto sizing warns using the intended notional, not its reduced fallback',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-funding-bark-')),store=new Store(dir),ids=identities();
  let body='';
  try {
    store.bind(ids.map(i=>i.address),'BTC');
    const a=wallet(),b=wallet(1);a.available=amount('100');b.available=amount('500');
    const cfg={...config(),autoLeverage:true,targetNotionalUsdc:'10000',marginUsdc:'333.33',maxLeverage:50,marginUtilizationBps:6667,capitalPerWalletUsdc:'500'};
    const decision=decideStrategy(cfg,trading(),market(),protocol(),[a,b]);
    assert(decision.reasons.some(r=>r.includes('资金所需')));
    const api={pendingReward:async()=>0n} as unknown as TradingApi;
    const fetcher=(async(_url:URL|RequestInfo,init?:RequestInit)=>{body=(JSON.parse(String(init?.body)) as {body:string}).body;return new Response(JSON.stringify({code:200}),{status:200});}) as typeof fetch;
    const notifier=new TradeNotifier(store,api,[a.address,b.address],()=>market(),()=>null,'https://bark.example/test-device/',fetcher);
    notifier.queueMarginWarning(cfg,decision,market(),[a,b],decision.reasons);await notifier.shutdown();
    assert.match(body,/目标单边名义仓位：10000\.00 USDC/);
    assert.match(body,/钱包 A .*缺口 199\.99 USDC/);
    assert.match(body,/钱包 B .*缺口 0\.00 USDC/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Bark sends account balances, round PNL, PAPER, staking and claimable rewards once without exposing key',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-bark-')),store=new Store(dir),ids=identities();
  let sends=0,body='';
  try {
    store.bind(ids.map(i=>i.address),'BTC');
    const a=wallet(),b=wallet(1);a.balance=amount('500');a.available=amount('400');a.locked=amount('100');
    b.balance=amount('499');b.available=amount('499');b.paper=amount('38');b.staked=amount('1000');
    store.snapshot(a);store.snapshot(b);
    const round:Round={id:1,state:'complete',createdAt:0,reason:'test',legs:[
      {wallet:a.address,openIntent:('0x'+'a'.repeat(64)) as `0x${string}`,position:null,closeIntent:null,settled:{id:'1',instrumentId:0,isLong:true,margin:amount('100'),leverage:10,liquidated:false,netPnl:amount('2'),paper:0n}},
      {wallet:b.address,openIntent:('0x'+'b'.repeat(64)) as `0x${string}`,position:null,closeIntent:null,settled:{id:'2',instrumentId:0,isLong:false,margin:amount('100'),leverage:10,liquidated:false,netPnl:-amount('3'),paper:amount('38')}}]};
    store.saveRound(round);
    const api={pendingReward:async()=>amount('0.25')} as unknown as TradingApi;
    const fetcher=(async(_url:URL|RequestInfo,init?:RequestInit)=>{sends++;const payload=JSON.parse(String(init?.body)) as {body:string;device_key:string};
      body=payload.body;assert.equal(payload.device_key,'test-device');return new Response(JSON.stringify({code:200}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
    const notifier=new TradeNotifier(store,api,[a.address,b.address],()=>market(),()=>null,'https://bark.example/test-device/',fetcher);
    notifier.queue('round_settled',1);await notifier.shutdown();notifier.queue('round_settled',1);await notifier.shutdown();
    assert.equal(sends,1);assert.match(body,/两边合计 PNL：-1\.00 USDC/);assert.match(body,/余额 500\.00 USDC/);
    assert.match(body,/PAPER 38\.00，已质押 1000\.00/);assert.match(body,/当前可领取分红：0\.25 USDC/);
    assert(!body.includes('test-device'));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
