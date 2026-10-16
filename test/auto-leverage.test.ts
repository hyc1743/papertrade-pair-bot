import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configSchema } from '../src/config.js';
import { decideStrategy, effectiveConfig } from '../src/strategy.js';
import { checkOpen } from '../src/math.js';
import { amount } from '../src/util.js';
import { market, NOW, protocol, trading, wallet } from './fixtures.js';

const config=()=>configSchema.parse({marginUsdc:'200',leverage:50,autoLeverage:true,targetNotionalUsdc:'10000',maxLeverage:100,strategyMode:'lpDynamic',capitalPerWalletUsdc:'300',autoStake:true});
const wallets=(a:string,b:string)=>[wallet(),wallet(1)].map((w,i)=>({...w,available:amount(i===0?a:b)}));
const activeConfig=()=>configSchema.parse(JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8')));
test('active 500U template lowers leverage without increasing nominal exposure or removing cash reserves',()=>{
  const c=activeConfig(),t=trading(),m=market(),p=protocol(),ws=wallets('500','500');
  const d=decideStrategy(c,t,m,p,ws,NOW);
  assert(d.canOpen,d.reasons.join('; '));assert.equal(d.leverage,31);assert.equal(d.closeMoveBps,15);
  assert(amount(d.marginUsdc)>amount('322.58')&&amount(d.marginUsdc)<amount('322.59'));
  assert(amount(d.notionalUsdc)>=amount('10000')&&amount(d.notionalUsdc)<amount('10000.01'));
  assert(amount('500')-amount(d.marginUsdc)>amount('177.41'));
  assert.deepEqual(checkOpen(effectiveConfig(c,d),t,m,ws,1000000n),[]);
  assert.equal(c.maxNetLossUsdc,null);assert.equal(c.maxRounds,null);
});
test('500U template follows weaker-wallet cash and pauses above 50x rather than chasing lost equity',()=>{
  const c=activeConfig(),t=trading(),m=market(),p=protocol();
  for(const [cash,leverage] of [['500',31],['450',34],['400',38],['350',43],['300',50]] as const) {
    const ws=wallets('500',cash),d=decideStrategy(c,t,m,p,ws,NOW);
    assert(d.canOpen,d.reasons.join('; '));assert.equal(d.leverage,leverage);
    assert.deepEqual(checkOpen(effectiveConfig(c,d),t,m,ws,1000000n),[]);
  }
  const paused=decideStrategy(c,t,m,p,wallets('500','250'),NOW);
  assert(!paused.canOpen);assert.equal(paused.leverage,50);assert(paused.reasons.some(r=>r.includes('杠杆超过')));
  const surplus=protocol();surplus.paper.trackedLp=surplus.paper.cap;surplus.lpCash=surplus.paper.cap;surplus.feesLifetime=amount('1');
  const ws=wallets('500','300');ws[0]!.staked=amount('2450');
  const d=decideStrategy(c,t,m,surplus,ws,NOW);assert(d.canOpen,d.reasons.join('; '));assert.equal(d.phase,'activation');assert(d.closeMoveBps>=15&&d.closeMoveBps<=50);
});
test('1-second poll defaults and opt-in automatic leverage preserve legacy configs',()=>{
  const c=config();assert.equal(c.lpPollIntervalMs,1000);assert.equal(c.rewardPollIntervalMs,1000);
  assert.equal(configSchema.parse({marginUsdc:'200',leverage:50}).autoLeverage,false);
});
test('weaker wallet determines matched leverage, even if the other has more cash',()=>{
  const c=config(),t=trading(),p=protocol();
  for(const [cash,expected] of [['300',50],['250',60],['200',75],['150',100]] as const) {
    const w=wallets('500',cash),d=decideStrategy(c,t,market(),p,w,NOW);
    assert(d.canOpen,d.reasons.join('; '));assert.equal(d.leverage,expected);
    assert(amount(d.notionalUsdc)>=amount('10000'));assert(amount(d.marginUsdc)<=amount('200'));
    assert.deepEqual(checkOpen(effectiveConfig(c,d),t,market(),w,1000000n),[]);
    assert.equal(d.walletSizing?.[1]?.requiredLeverage,String(expected));
  }
});
test('leverage decreases when available funds recover',()=>{
  const c=config(),t=trading(),p=protocol();
  assert.equal(decideStrategy(c,t,market(),p,wallets('300','200'),NOW).leverage,75);
  assert.equal(decideStrategy(c,t,market(),p,wallets('300','300'),NOW).leverage,50);
});
test('hard leverage and market caps pause instead of using unlimited leverage',()=>{
  const c=config(),t=trading(),p=protocol(),w=wallets('300','100');
  const d=decideStrategy(c,t,market(),p,w,NOW);assert(!d.canOpen);assert(d.leverage<=100);assert(d.reasons.some(x=>x.includes('杠杆超过')));
  const m=market();m.maxLeverage=60;assert(!decideStrategy(c,t,m,p,wallets('300','200'),NOW).canOpen);
});
test('100 bps surplus target pauses if funding requires unsafe leverage',()=>{
  const c=config(),p=protocol(),w=wallets('300','175');w[0]!.staked=amount('2450');
  p.paper.trackedLp=p.paper.cap;p.lpCash=p.paper.cap;p.feesLifetime=amount('1');
  const d=decideStrategy(c,trading(),market(),p,w,NOW);assert(!d.canOpen);assert.equal(d.closeMoveBps,100);assert(d.reasons.some(x=>x.includes('强平缓冲')));
});
test('zero/microscopic budgets cannot overflow leverage numbers; queued never supplies margin',()=>{
  const c=config(),w=wallets('300','0.000000000000000001');w[1]!.queued=amount('10000');
  const d=decideStrategy(c,trading(),market(),protocol(),w,NOW);assert(!d.canOpen);assert(Number.isSafeInteger(d.leverage));assert(d.leverage>=1&&d.leverage<=100);
});
test('automatic leverage also applies to fixed-threshold mode',()=>{
  const c={...config(),strategyMode:'fixed' as const,closeMoveBps:50};
  const d=decideStrategy(c,trading(),market(),protocol(),wallets('300','200'),NOW);
  assert(d.canOpen);assert.equal(d.leverage,75);assert.equal(d.closeMoveBps,50);
});
