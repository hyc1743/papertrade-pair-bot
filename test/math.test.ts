import test from 'node:test';
import assert from 'node:assert/strict';
import { bustDistanceBps, checkOpen, chooseLeadOpenLeg, entryGapBpsCeil, entryGapTooLarge, estimatePaper, estimateRoundCost, movedBeyond, movedBeyondWithEntryGap, netPnl } from '../src/math.js';
import { amount } from '../src/util.js';
import { WAD } from '../src/types.js';
import { config, market, position, protocol, trading, wallet } from './fixtures.js';

test('strict 100 bps boundary, up/down, fractional mean and large integers',()=>{
  assert.equal(movedBeyond(1009999n,[1000000n,1000000n]),false);
  assert.equal(movedBeyond(1010000n,[1000000n,1000000n]),false);
  assert.equal(movedBeyond(1010001n,[1000000n,1000000n]),true);
  assert.equal(movedBeyond(990000n,[1000000n,1000000n]),false);
  assert.equal(movedBeyond(989999n,[1000000n,1000000n]),true);
  assert.equal(movedBeyond(1000000n,[999999n,1000001n]),false);
  assert.equal(movedBeyond(10n**30n,[10n**30n,10n**30n]),false);
});
test('actual fill gap is added to the exit move with exact fractional-bps precision',()=>{
  const entries:[bigint,bigint]=[1_000_000n,1_000_200n];
  assert.equal(entryGapBpsCeil(entries),2);
  assert.equal(movedBeyond(1_002_601n,entries,25),true);
  assert.equal(movedBeyondWithEntryGap(1_002_800n,entries,25),false);
  assert.equal(movedBeyondWithEntryGap(1_002_801n,entries,25),true);
  assert.equal(movedBeyondWithEntryGap(997_399n,entries,25),true);
  assert.equal(movedBeyondWithEntryGap(1_002_500n,[1_000_000n,1_000_000n],25),false);
});
test('winning 1% move includes deadband, impact and 2% fee; losses not haircutted',()=>{
  const p=position(),m=market(),pnl=netPnl(p,1010000n,m);
  assert(pnl>amount('86')&&pnl<amount('87'));
  assert.equal(netPnl({...p,isLong:false},1010000n,m),-amount('100'));
  assert.equal(netPnl(p,1000019n,m),0n);
  assert.equal(netPnl(p,900000n,m),-p.margin);
  assert(estimateRoundCost(m,p.margin,p.leverage,100)>amount('13'));
});
test('mint eligible loss basis and integrated ratchet',()=>{
  const c=protocol();assert.equal(estimatePaper(amount('100'),c),amount('9800'));
  c.queue=1n;assert.equal(estimatePaper(amount('100'),c),amount('10000'));
  c.paper.trackedLp=c.paper.cliff;c.paper.tail=amount('100000000');
  const minted=estimatePaper(amount('100'),c);assert(minted>amount('2900')&&minted<amount('3000'));
  c.paper.tail=0n;c.paper.trackedLp=c.paper.cliff-amount('50');
  assert(estimatePaper(amount('100'),c)<amount('10000'));
});
test('checks real minima, cash not queued, leverage, OI and intake pause',()=>{
  const c=config(),t=trading(),m=market(),ws=[wallet(),wallet(1)];
  assert.deepEqual(checkOpen(c,t,m,ws,1000000n),[]);
  assert(checkOpen({...c,marginUsdc:'50'},t,m,ws,1000000n).some(s=>s.includes('名义本金')));
  assert(checkOpen({...c,leverage:100},t,m,ws,1000000n).some(s=>s.includes('强平缓冲')));
  ws[0]!.available=0n;ws[0]!.queued=1000000n*WAD;
  assert(checkOpen(c,t,m,ws,1000000n).some(s=>s.includes('可用 USDC')));
  t.disabledActions=['closePositions'];assert(checkOpen(c,t,m,ws,1000000n).some(s=>s.includes('暂停')));
  m.longCap=0n;assert(checkOpen(c,t,m,ws,1000000n).some(s=>s.includes('OI')));
  assert.equal(bustDistanceBps(position()),495n);
  assert.equal(entryGapTooLarge([1000000n,1000101n],1),true);
  assert.equal(entryGapTooLarge([834405n,834555n],3),false);
  assert.equal(entryGapTooLarge([834405n,834705n],3),true);
});
test('OI safety margin blocks near-cap opens even when the raw order would fit',()=>{
  const c={...config(),oiHeadroomUsdc:'200000'},t=trading(),m=market(),ws=[wallet(),wallet(1)];
  m.longCap=m.longOi+amount('1');
  assert.deepEqual(checkOpen({...c,oiHeadroomUsdc:'0'},t,m,ws,1000000n),[]);
  assert(checkOpen(c,t,m,ws,1000000n).some(x=>x.includes('市场方向 OI 安全余量')));
  m.longCap=amount('100000');t.maxNetOi=amount('100000');
  assert(checkOpen(c,t,m,ws,1000000n).some(x=>x.includes('接入层净 OI 安全余量')));
});
test('the more constrained OI direction is submitted first',()=>{
  const t=trading(),m=market();m.longCap=amount('3');m.shortCap=amount('100000');
  assert.equal(chooseLeadOpenLeg(t,m,1000000n,amount('10000'),[true,false]),0);
  assert.equal(chooseLeadOpenLeg(t,m,1000000n,amount('10000'),[false,true]),1);
});
