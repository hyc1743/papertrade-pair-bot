import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../src/config.js';
import { decideLiveClose, decideStrategy } from '../src/strategy.js';
import { estimatePaper } from '../src/math.js';
import { amount } from '../src/util.js';
import type { Position, Wallet } from '../src/types.js';
import { market, NOW, protocol, trading, wallet } from './fixtures.js';

const config=()=>configSchema.parse({marginUsdc:'333.33',leverage:31,maxNetLossUsdc:null,strategyMode:'lpAccumulating',
  capitalPerWalletUsdc:'500',targetNotionalUsdc:'10000',autoLeverage:true,maxLeverage:50,bustHeadroomBps:50,
  autoStake:true,autoClaim:false,accumulationMinBps:15,accumulationRounds:2,costEfficiencyToleranceBps:2000,slowCloseAfterMs:30000});
function state(){
  const p=protocol(),ws=[wallet(),wallet(1)];
  ws.forEach(w=>{w.balance=amount('500');w.available=amount('500');});
  p.paper.trackedLp=amount('2865366.764013');p.paper.tail=amount('66746697.991411');p.lpCash=p.paper.trackedLp;
  return {p,ws};
}
test('both wallets unstaked: choose a fast two-loss accumulation threshold from the live curve',()=>{
  const {p,ws}=state(),c=config(),d=decideStrategy(c,trading(),market(),p,ws,NOW);
  assert(d.canOpen,d.reasons.join('; '));assert.equal(d.mode,'lpAccumulating');assert.equal(d.closeMoveBps,15);
  assert.equal(d.plannedLossesPerWallet,2);
  assert(amount(d.conservativePaper!)<amount(d.stakeTargetPaper!));
  const notional=amount(d.marginUsdc)*BigInt(d.leverage);
  const worstLoss=notional*BigInt(2*d.closeMoveBps-c.maxEntryGapBps)/20000n;
  assert(estimatePaper(worstLoss*2n,p)>=amount(d.stakeTargetPaper!));
  assert(amount(d.projectedPaperAfterRounds!)>=amount(d.stakeTargetPaper!));
});
test('after the first wallet stakes, target the remaining wallet’s one-loss shortfall',()=>{
  const {p,ws}=state(),c=config();ws[0]!.staked=amount('1000');
  assert.equal(decideStrategy(c,trading(),market(),p,ws,NOW).closeMoveBps,27);
  ws[1]!.paper=amount('600');const d=decideStrategy(c,trading(),market(),p,ws,NOW);
  assert.equal(d.phase,'activation');assert.equal(d.closeMoveBps,15);
  assert.equal(d.walletStakePlans?.[0]?.alreadyStaked,true);
  assert.equal(d.walletStakePlans?.[1]?.shortfallToMinimumPaper,'400');
  assert.equal(d.walletStakePlans?.[1]?.shortfallToTargetPaper,'450');
});
test('PAPER from the two wallets is never pooled to satisfy either staking minimum',()=>{
  const {p,ws}=state(),c=config();ws[1]!.paper=amount('210');
  const d=decideStrategy(c,trading(),market(),p,ws,NOW);
  assert.equal(d.walletStakePlans?.[0]?.shortfallToMinimumPaper,'1000');
  assert.equal(d.walletStakePlans?.[1]?.shortfallToMinimumPaper,'790');
  assert.equal(d.walletStakePlans?.[0]?.estimatedLossesToTarget,2);
  ws[1]!.staked=amount('1000');ws[1]!.paper=0n;
  const next=decideStrategy(c,trading(),market(),p,ws,NOW);
  assert.equal(next.phase,'activation');assert.equal(next.closeMoveBps,27);
  assert.equal(next.walletStakePlans?.[0]?.shortfallToMinimumPaper,'1000');
});
test('once both are staked, warm up at 50 bps and use BTC realized volatility when available',()=>{
  const {p,ws}=state(),c=config();ws.forEach(w=>w.staked=amount('1000'));
  assert.equal(decideStrategy(c,trading(),market(),p,ws,NOW).closeMoveBps,50);
  const vol={sigmaBpsPerSqrtMinute:10,returnSamples:30,observedMinutes:30,latestMinute:300};
  const priced=decideStrategy(c,trading(),market(),p,ws,NOW,vol);
  assert.equal(priced.closeMoveBps,100);assert.equal(priced.volatilitySamples,30);
  assert.equal(c.autoClaim,false);
});
test('an existing hedge reprices without resizing: 15 then 10 then 8 bps only within the total-cost cap',()=>{
  const {p,ws}=state(),c=config(),entry=830195n,margin=amount('322.580645161290322581');
  const positions=[true,false].map((isLong,i)=>({id:String(i),instrumentId:0,isLong,useDebt:false,entry,margin,leverage:31,
    bust:isLong?entry*97n/100n:entry*103n/100n,openedAtMs:NOW,intentId:null})) as [Position,Position];
  const initial=decideLiveClose(c,trading(),market(),p,ws as [Wallet,Wallet],positions,0,NOW);
  const slow=decideLiveClose(c,trading(),market(),p,ws as [Wallet,Wallet],positions,c.slowCloseAfterMs,NOW,5);
  assert.equal(initial?.closeMoveBps,15);assert.equal(slow?.closeMoveBps,10);
  assert.equal(slow?.plannedLossesPerWallet,3);
  const later=decideLiveClose({...c,slowCloseFloorBps:8},trading(),market(),p,ws as [Wallet,Wallet],positions,c.slowCloseAfterMs+c.slowCloseStepMs,NOW,5);
  assert.equal(later?.closeMoveBps,8);assert.equal(later?.plannedLossesPerWallet,4);
  ws[1]!.paper=amount('210');
  const skewed=decideLiveClose({...c,slowCloseFloorBps:8},trading(),market(),p,ws as [Wallet,Wallet],positions,c.slowCloseAfterMs+c.slowCloseStepMs,NOW,5);
  assert.equal(skewed?.plannedLossesPerWallet,4);
  assert.equal(skewed?.walletStakePlans[0]?.estimatedLossesToTarget,4);
  assert.equal(skewed?.walletStakePlans[1]?.estimatedLossesToTarget,3);
  ws[1]!.paper=0n;
  const costly=decideLiveClose({...c,slowCloseFloorBps:8,slowCloseCostToleranceBps:0},trading(),market(),p,ws as [Wallet,Wallet],positions,c.slowCloseAfterMs+c.slowCloseStepMs,NOW,5);
  assert.equal(costly?.closeMoveBps,14);
  assert.equal(decideLiveClose(c,trading(),market(),p,ws as [Wallet,Wallet],positions,c.slowCloseAfterMs,NOW,20)?.closeMoveBps,15);
  assert.equal(decideLiveClose({...c,slowCloseFloorBps:8},trading(),market(),p,ws as [Wallet,Wallet],positions,c.slowCloseForceAfterMs,NOW,20)?.closeMoveBps,8);
  ws[0]!.staked=amount('1000');
  assert.equal(decideLiveClose(c,trading(),market(),p,ws as [Wallet,Wallet],positions,0,NOW,5)?.closeMoveBps,27);
  const oneWalletSlow=decideLiveClose(c,trading(),market(),p,ws as [Wallet,Wallet],positions,c.slowCloseAfterMs,NOW,5);
  assert(oneWalletSlow&&oneWalletSlow.closeMoveBps<27&&oneWalletSlow.closeMoveBps>=10);
  assert.equal(oneWalletSlow.walletStakePlans[0]?.alreadyStaked,true);
  assert.equal(oneWalletSlow.walletStakePlans[1]?.alreadyStaked,false);
});
