import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../src/config.js';
import { selectCostModeTarget } from '../src/strategy.js';
import { PriceVolatility, expectedHitMinutes } from '../src/volatility.js';
import { amount } from '../src/util.js';
import { market, protocol } from './fixtures.js';

test('one-minute BTC prices produce rolling realized volatility and ignore missing-minute jumps',()=>{
  const start=1_800_000_000_000,tracker=new PriceVolatility();let price=100_000_000;
  for(let i=0;i<31;i++){
    if(i)price=Math.round(price*Math.exp((i%2?10:-10)/10000));
    tracker.observe(BigInt(price),start+i*60000);
  }
  const vol=tracker.estimate(start+30*60000)!;
  assert(vol.returnSamples>=25);assert(vol.sigmaBpsPerSqrtMinute>9&&vol.sigmaBpsPerSqrtMinute<11);
  assert(expectedHitMinutes(100,vol)>80&&expectedHitMinutes(100,vol)<125);
  assert(expectedHitMinutes(100,vol,50)<expectedHitMinutes(100,vol));
  assert(vol.sigma5Bps!==null&&vol.sigma5Bps!==undefined);assert(vol.sigma15Bps!==null&&vol.sigma15Bps!==undefined);
  assert((vol.trendEfficiency15??1)<0.2);assert((vol.range15Bps??0)>0);
  const restored=new PriceVolatility(tracker.export());assert(restored.estimate(start+30*60000));
  restored.observe(100_000_000n,start+90*60000);
  assert.equal(restored.estimate(start+94*60000),null);
});
test('two-staked mode chooses cheapest safe BPS within BTC-price-based eight-hour horizon',()=>{
  const c=configSchema.parse({marginUsdc:'312.5',leverage:32,strategyMode:'lpAccumulating'}),m=market(),p=protocol(),margin=amount('312.5');
  const fast={sigmaBpsPerSqrtMinute:10,returnSamples:30,observedMinutes:30,latestMinute:300};
  const slow={...fast,sigmaBpsPerSqrtMinute:2};
  assert.equal(selectCostModeTarget(c,m,p,margin,32,null,()=>true)?.closeMoveBps,50);
  assert.equal(selectCostModeTarget(c,m,p,margin,32,fast,()=>true)?.closeMoveBps,100);
  const picked=selectCostModeTarget(c,m,p,margin,32,slow,()=>true)!;
  assert(picked.closeMoveBps>=40&&picked.closeMoveBps<=44);
  assert(picked.estimatedHoldMinutes!==null&&picked.estimatedHoldMinutes<=480);
  assert.equal(selectCostModeTarget(c,m,p,margin,32,fast,x=>x<=75)?.closeMoveBps,75);
  const noMove=selectCostModeTarget(c,m,p,margin,32,{...fast,sigmaBpsPerSqrtMinute:0},()=>true)!;
  assert.equal(noMove.closeMoveBps,25);assert.equal(noMove.horizonSatisfied,false);
});
