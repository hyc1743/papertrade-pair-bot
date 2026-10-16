import type { Config } from './config.js';
import { estimatePaper, netPnl } from './math.js';
import { EMPTY_EFFICIENCY_CONTEXT, type EfficiencyContext } from './efficiency-data.js';
import { WAD, type CloseOptimization, type Market, type Position, type Protocol, type Wallet } from './types.js';
import { abs, max, min, usd } from './util.js';
import { expectedHitMinutes, type VolatilityEstimate } from './volatility.js';

/** Adverse fill spread for sizing before fills; live evaluation uses exact observed entries. */
export function plannedPair(m:Market,margin:bigint,leverage:number,gapBps:number):[Position,Position] {
  const mean=100_000_000n,half=(mean*BigInt(gapBps)+19999n)/20000n;
  const common={id:'model',instrumentId:m.id,useDebt:false,margin,leverage,bust:0n,openedAtMs:0,intentId:null};
  return [{...common,isLong:true,entry:mean+half},{...common,isLong:false,entry:mean-half}];
}
export function throughputTolerance(config:Config,ageMs:number):number {
  const progress=Math.min(1,Math.max(0,ageMs)/(config.throughputAgeRampMinutes*60000));
  return Math.floor(config.throughputCostToleranceBps+(config.throughputAgedToleranceBps-config.throughputCostToleranceBps)*progress);
}
export function effectiveSigma(vol:VolatilityEstimate):number {
  const slow=vol.sigmaBpsPerSqrtMinute,fast=vol.sigma5Bps??slow,medium=vol.sigma15Bps??slow;
  return Math.min(slow*1.5,Math.max(slow*0.6,Math.sqrt(0.2*fast*fast+0.3*medium*medium+0.5*slow*slow)));
}

/** Expected unit cost is a hard candidate constraint; elapsed age is never an exit deadline. */
export function selectEfficiencyTarget(config:Config,m:Market,p:Protocol,positions:[Position,Position],vol:VolatilityEstimate|null,
  safe:(bps:number)=>boolean,wallets:Wallet[],minStake:bigint,ageMs=0,quoteMid:bigint|null=null,
  context:EfficiencyContext=EMPTY_EFFICIENCY_CONTEXT):CloseOptimization|null {
  if(positions.some(x=>x.entry<=0n||x.margin<=0n||x.leverage<=0||x.useDebt)||positions[0].isLong===positions[1].isLong||p.queue>0n)return null;
  const sum=positions[0].entry+positions[1].entry,diff=abs(positions[0].entry-positions[1].entry);
  const gap=Number(diff*200000000n/sum)/10000,currentSigned=quoteMid===null?0:Number((2n*quoteMid-sum)*1000000n/sum)/100;
  const sigma=vol?effectiveSigma(vol):0,hasForecast=Number.isFinite(sigma)&&sigma>0;
  const medianClose=Math.max(0,context.closeDelayMinutes),p90Close=Math.max(medianClose,context.closeP90Minutes);
  const closeDelay=medianClose+0.25*(p90Close-medianClose),openDelay=Math.max(0,context.openDelayMinutes);
  const tolerance=throughputTolerance(config,ageMs),trend=Math.max(0,Math.min(1,vol?.trendEfficiency15??0));
  const choices=[] as {bps:number;cost:bigint;rawPaper:bigint;paper:bigint;hit:number;cycle:number;score:number}[];
  for(let bps=config.costModeMinBps;bps<=config.costModeMaxBps;bps++) {
    if(!safe(bps))continue;
    const up=(sum*BigInt(10000+bps)+19999n)/20000n+diff,down=sum*BigInt(10000-bps)/20000n-diff;
    if(down<=0n)continue;
    const settlements=[up,down].map(price=>{
      const pnls=positions.map(pos=>netPnl(pos,price,m)),loss=pnls.reduce((v,n)=>v+max(0n,-n),0n);
      return {cost:max(0n,-pnls[0]!-pnls[1]!),paper:estimatePaper(loss,p)};
    });
    const cost=max(settlements[0]!.cost,settlements[1]!.cost),rawPaper=min(settlements[0]!.paper,settlements[1]!.paper);
    if(rawPaper<=0n)continue;
    let hit=hasForecast?expectedHitMinutes(bps+gap,{...vol!,sigmaBpsPerSqrtMinute:sigma},Math.abs(currentSigned)):Infinity;
    if(Number.isFinite(hit)&&hit>0&&vol) {
      // Bounded regime modifiers: choppy ranges penalize far-away targets;
      // persistent movement toward the nearest boundary modestly reduces wait.
      const remaining=Math.max(0,bps+gap-Math.abs(currentSigned)),range=vol.range15Bps;
      if(range!==null&&range!==undefined&&range>0)hit*=1+0.3*(1-trend)*Math.min(1,remaining/range);
      const follows=currentSigned!==0&&Math.sign(currentSigned)===Math.sign(vol.signedReturn15Bps??0);
      hit*=follows?1-0.25*trend:1+0.25*trend;
    }
    const cycle=Math.max(0.25,hit+closeDelay+openDelay);
    // Six hours limits extrapolation of the observed decline, not holding time.
    const forecastMinutes=Number.isFinite(hit)?Math.min(360,hit+closeDelay):0;
    const factor=BigInt(Math.floor(Math.exp(-Math.max(0,context.rateDeclinePerMinute)*forecastMinutes)*1_000_000_000));
    const paper=rawPaper*factor/1_000_000_000n;
    if(paper<=0n)continue;
    const batchRounds=wallets.map(w=>Number((max(0n,minStake-w.paper)+paper-1n)/paper));
    const averageExtra=batchRounds.length?batchRounds.reduce((v,n)=>v+Math.max(0,n-1),0)/batchRounds.length:0;
    const score=Number(usd(paper))*60/cycle/(1+0.05*averageExtra);
    choices.push({bps,cost,rawPaper,paper,hit,cycle,score});
  }
  if(!choices.length)return null;
  const cheapest=choices.reduce((a,b)=>b.cost*a.rawPaper<a.cost*b.rawPaper?b:a,choices[0]!);
  const eligible=choices.filter(x=>x.cost*cheapest.rawPaper*10000n<=cheapest.cost*x.paper*BigInt(10000+tolerance));
  if(!eligible.length)return null;
  const best=hasForecast?eligible.reduce((a,b)=>b.score>a.score||b.score===a.score&&b.cost*a.paper<a.cost*b.paper?b:a,eligible[0]!):
    eligible.reduce((a,b)=>Math.abs(b.bps-config.costModeWarmupBps)<Math.abs(a.bps-config.costModeWarmupBps)?b:a,eligible[0]!);
  const baseUnit=cheapest.cost*WAD/cheapest.rawPaper;
  return {closeMoveBps:best.bps,costPerPaperUsdc:usd(best.cost*WAD/best.paper),estimatedHoldMinutes:Number.isFinite(best.hit)?Math.round(best.hit*10)/10:null,
    volatilityBpsPerSqrtMinute:vol?.sigmaBpsPerSqrtMinute??null,volatilitySamples:vol?.returnSamples??0,horizonSatisfied:true,
    closeEfficiency:{costToleranceBps:tolerance,minimumCostPerPaperUsdc:usd(baseUnit),costLimitPerPaperUsdc:usd(baseUnit*BigInt(10000+tolerance)/10000n),
      projectedCostUsdc:usd(best.cost),projectedPaper:usd(best.paper),estimatedPaperPerHour:Number.isFinite(best.cycle)?Math.round(Number(usd(best.paper))*60/best.cycle*10)/10:0,
      stakeAdjustedPaperPerHour:Number.isFinite(best.score)?Math.round(best.score*10)/10:0,
      estimatedCycleMinutes:Number.isFinite(best.cycle)?Math.round(best.cycle*10)/10:0,closeDelayMinutes:closeDelay,closeP90Minutes:p90Close,openDelayMinutes:openDelay,
      executionSamples:context.executionSamples,rateDeclinePerMinute:context.rateDeclinePerMinute,rateTrendSamples:context.rateTrendSamples,
      effectiveSigmaBps:sigma,trendEfficiency:trend,range15Bps:vol?.range15Bps??null,
      walletBatchPlans:wallets.map(w=>{const shortfall=max(0n,minStake-w.paper),losses=Number((shortfall+best.paper-1n)/best.paper);
        return {wallet:w.address,minimumPaper:usd(minStake),availablePaper:usd(w.paper),shortfallPaper:usd(shortfall),estimatedLosingRounds:losses,
          // Balanced loss-side allocation is an estimate, never a transfer between wallets.
          estimatedBatchMinutes:Number.isFinite(best.cycle)?Math.round(2*losses*best.cycle*10)/10:0};})}};
}
