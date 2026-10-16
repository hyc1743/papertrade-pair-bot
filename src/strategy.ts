import type { Config } from './config.js';
import { bustDistanceBps, entryGapBpsCeil, estimatePaper, estimateRoundCost } from './math.js';
import { abs, amount, max, min, usd } from './util.js';
import { WAD, type CloseOptimization, type Market, type Position, type Protocol, type StrategyDecision, type Trading, type Wallet, type WalletStakePlan } from './types.js';
import { expectedHitMinutes, type VolatilityEstimate } from './volatility.js';
import { plannedPair, selectEfficiencyTarget } from './efficiency.js';
import { EMPTY_EFFICIENCY_CONTEXT, type EfficiencyContext } from './efficiency-data.js';

export function mintRate(protocol:Protocol):bigint {
  const c=protocol.paper;
  return c.trackedLp<c.cliff?c.rate:c.rate*c.decay*c.decay/((c.decay+c.tail)**2n);
}
const ceilDiv=(a:bigint,b:bigint)=>b>0n?(a+b-1n)/b:0n;
export function selectCostModeTarget(config:Config,m:Market,p:Protocol,margin:bigint,leverage:number,volatility:VolatilityEstimate|null,safe:(bps:number)=>boolean,currentMoveBps=0,entryGapBps=0):CloseOptimization|null {
  const n=margin*BigInt(leverage),choices=[] as {bps:number;paper:bigint;cost:bigint;hold:number}[];
  for(let bps=config.costModeMinBps;bps<=config.costModeMaxBps;bps++) {
    if(!safe(bps))continue;
    const loss=n*BigInt(Math.max(0,2*bps-config.maxEntryGapBps))/20000n,paper=estimatePaper(loss,p);
    if(paper<=0n)continue;
    choices.push({bps,paper,cost:estimateRoundCost(m,margin,leverage,bps+entryGapBps),hold:volatility?expectedHitMinutes(bps+entryGapBps,volatility,currentMoveBps):Infinity});
  }
  if(!choices.length)return null;
  const holdLimit=config.costModeMaxHoldMinutes;
  let eligible=volatility?choices.filter(x=>holdLimit===null||x.hold<=holdLimit):[];
  const horizonSatisfied=eligible.length>0;
  if(!eligible.length)eligible=volatility?[choices[0]!]:[choices.reduce((best,x)=>Math.abs(x.bps-config.costModeWarmupBps)<Math.abs(best.bps-config.costModeWarmupBps)?x:best,choices[0]!)];
  const best=eligible.reduce((a,b)=>b.cost*a.paper<a.cost*b.paper||b.cost*a.paper===a.cost*b.paper&&b.hold<a.hold?b:a,eligible[0]!);
  return {closeMoveBps:best.bps,costPerPaperUsdc:usd(best.cost*WAD/best.paper),estimatedHoldMinutes:Number.isFinite(best.hold)?Math.round(best.hold*10)/10:null,
    volatilityBpsPerSqrtMinute:volatility?.sigmaBpsPerSqrtMinute??null,volatilitySamples:volatility?.returnSamples??0,horizonSatisfied};
}
function stakePlans(ws:Wallet[],minimum:bigint,target:bigint,mint:(count:number)=>bigint,plannedRounds:number,searchLimit:number):WalletStakePlan[] {
  return ws.map(w=>{
    const alreadyStaked=w.staked>0n;
    let estimatedLossesToTarget:number|null=alreadyStaked?0:null;
    if(!alreadyStaked)for(let count=0;count<=searchLimit;count++)if(w.paper+mint(count)>=target){estimatedLossesToTarget=count;break;}
    return {wallet:w.address,alreadyStaked,availablePaper:usd(w.paper),stakedPaper:usd(w.staked),minimumPaper:usd(minimum),targetPaper:usd(target),
      shortfallToMinimumPaper:usd(alreadyStaked?0n:max(0n,minimum-w.paper)),shortfallToTargetPaper:usd(alreadyStaked?0n:max(0n,target-w.paper)),
      estimatedLossesToTarget,projectedPaperAfterPlannedLosses:usd(w.paper+(alreadyStaked?0n:mint(plannedRounds)))};
  });
}

/** Deterministic sizing: no debt, equal exposure, per-wallet budgets, bounded shared leverage. */
export function decideStrategy(config:Config,t:Trading,m:Market,p:Protocol,ws:Wallet[],now=Date.now(),volatility:VolatilityEstimate|null=null,execution:EfficiencyContext=EMPTY_EFFICIENCY_CONTEXT):StrategyDecision {
  const reasons:string[]=[],dynamic=config.strategyMode!=='fixed',accumulating=config.strategyMode==='lpAccumulating';
  let phase:StrategyDecision['phase']='fixed',bps=config.closeMoveBps,margin=amount(config.marginUsdc),leverage=config.leverage;
  if(dynamic) {
    if(now-p.sourceAt>config.lpMaxAgeMs||p.sourceAt>now+5000)reasons.push('LP 链索引时间过期或时钟异常');
    if(p.queue>0n||ws.some(w=>w.queued>0n))reasons.push('支付队列或本账户应收盈利未清，暂停新仓');
    if(t.disabledActions.includes('paperStake')&&config.autoStake)reasons.push('官方质押入口暂停');
    if(config.autoStake&&mintRate(p)<=0n)reasons.push('当前有效铸币率为零，暂停新仓');
    const hasStake=ws.some(w=>w.staked>0n),allStaked=ws.length>0&&ws.every(w=>w.staked>0n),distributionObserved=p.feesLifetime>0n||p.paper.pendingRewards>0n;
    phase=accumulating?!allStaked?'activation':p.paper.trackedLp>=p.paper.cap&&distributionObserved?'surplus':'fees':!hasStake?'activation':p.paper.trackedLp>=p.paper.cap&&distributionObserved?'surplus':'fees';
    bps=accumulating?(phase==='activation'?config.accumulationMinBps:25):phase==='activation'?25:phase==='surplus'?100:50;
  }

  // `leverage` remains the reference setting for old configs; auto mode has an explicit target.
  let nominal=config.targetNotionalUsdc!==null?amount(config.targetNotionalUsdc):margin*BigInt(config.leverage);
  if(dynamic&&(phase==='activation'||p.paper.trackedLp<p.paper.cliff))nominal=min(nominal,t.minNotional);
  const target=nominal;
  const budgets=ws.map(w=>{
    let available=w.available;
    if(config.capitalPerWalletUsdc!==null)available=min(available,amount(config.capitalPerWalletUsdc));
    if(config.autoLeverage)available=available*BigInt(config.marginUtilizationBps)/10000n;
    return min(amount(config.marginUsdc),available);
  });
  let fundedMargin=amount(config.marginUsdc);
  if(config.capitalPerWalletUsdc!==null)fundedMargin=min(fundedMargin,amount(config.capitalPerWalletUsdc));
  for(const budget of budgets)fundedMargin=min(fundedMargin,budget);
  const walletSizing=ws.map((w,i)=>({wallet:w.address,tradeSpendableUsdc:usd(w.available),marginBudgetUsdc:usd(budgets[i]!),requiredLeverage:budgets[i]!>0n?String(ceilDiv(target,budgets[i]!)):null}));

  const size=(requested:bigint)=>{
    if(config.autoLeverage) {
      const cap=Math.min(config.maxLeverage,m.maxLeverage);
      if(cap<config.minLeverage)reasons.push('市场最大杠杆低于配置最小杠杆');
      if(fundedMargin<=0n) {
        leverage=Math.max(1,Math.min(config.leverage,cap));margin=0n;
        reasons.push('两钱包可交易保证金预算为零');return;
      }
      const needed=max(BigInt(config.minLeverage),ceilDiv(requested,fundedMargin));
      leverage=Number(min(needed,BigInt(cap)));
      if(needed>BigInt(cap))reasons.push(`资金所需 ${needed} 倍杠杆超过允许上限 ${cap}，暂停新仓`);
      // Same rounded margin/leverage on both legs means exactly equal notional even at wei precision.
      margin=min(fundedMargin,ceilDiv(requested,BigInt(leverage)));
    } else if(dynamic) {
      const affordable=min(requested,fundedMargin*BigInt(leverage));
      margin=affordable/BigInt(leverage);
      if(margin*BigInt(leverage)<t.minNotional&&fundedMargin*BigInt(leverage)>=t.minNotional)margin=ceilDiv(t.minNotional,BigInt(leverage));
    }
  };
  if(dynamic||config.autoLeverage) {
    size(nominal);
    if(margin<=0n||margin>fundedMargin||margin*BigInt(leverage)<t.minNotional)reasons.push('两钱包可交易现金不足最低名义本金（保证金预算限制），继续分红监控');
    if(target<t.minNotional)reasons.push('目标名义本金低于实时最低要求');
  }

  const stakeTarget=t.minPaperStake*BigInt(config.stakeTargetBps)/10000n;
  const conservativeMint=(thresholdBps:number,rounds=1)=>{
    // The less-favourable entry can reduce the losing leg's move by up to half
    // of the maximum admitted difference between the two entry prices.
    const worstLoss=margin*BigInt(leverage)*BigInt(2*thresholdBps-config.maxEntryGapBps)/20000n;
    return estimatePaper(worstLoss*BigInt(rounds),p);
  };
  let plannedLossesPerWallet:number|undefined,projectedPaperAfterRounds:string|undefined;
  let costMode:ReturnType<typeof selectCostModeTarget>|null=null;
  if(dynamic) {
    const unstaked=accumulating?ws.filter(w=>w.staked===0n):ws;
    const rounds=accumulating&&unstaked.length===ws.length?config.accumulationRounds:1;
    if(accumulating&&unstaked.length)plannedLossesPerWallet=rounds;
    const upper=accumulating&&!unstaked.length?50:100;
    const referencePaper=accumulating&&!unstaked.length?conservativeMint(50):0n;
    const referenceCost=accumulating&&!unstaked.length?estimateRoundCost(m,margin,leverage,50):0n;
    const throughput=accumulating&&!unstaked.length&&config.costModeObjective==='throughput';
    if(accumulating&&!unstaked.length) {
      const safe=(x:number)=>WAD/BigInt(leverage)-m.bustBuffer>=BigInt(x+config.maxEntryGapBps+config.bustHeadroomBps)*WAD/10000n;
      costMode=throughput?selectEfficiencyTarget(config,m,p,plannedPair(m,margin,leverage,config.maxEntryGapBps),volatility,safe,ws,t.minPaperStake,0,null,execution):
        selectCostModeTarget(config,m,p,margin,leverage,volatility,safe,0,config.maxEntryGapBps);
      if(throughput&&!costMode)reasons.push('当前成本边界内无安全的效率档位，暂停新仓');
    }
    const chosen=throughput&&!costMode?undefined:costMode?.closeMoveBps??Array.from({length:upper-bps+1},(_,i)=>bps+i).find(x=>{
      const safe=WAD/BigInt(leverage)-m.bustBuffer>=BigInt(x+config.maxEntryGapBps+config.bustHeadroomBps)*WAD/10000n;
      if(!safe)return false;
      if(!accumulating||unstaked.length)return !config.autoStake||unstaked.every(w=>conservativeMint(x,rounds)+w.paper>=stakeTarget);
      const paper=conservativeMint(x);
      return paper>0n&&(referenceCost===0n||estimateRoundCost(m,margin,leverage,x)*referencePaper*10000n<=referenceCost*paper*BigInt(10000+config.costEfficiencyToleranceBps));
    });
    if(chosen===undefined)reasons.push(`允许的 ${bps}～${upper} bps 内预计 PAPER 不足${accumulating?'累计':''}质押目标、成本效率要求或强平缓冲；等待参数变化`);
    else bps=chosen;
    if(p.paper.trackedLp>=p.paper.cliff&&margin>0n) {
      const n=margin*BigInt(leverage),win=n*BigInt(bps)/10000n-estimateRoundCost(m,margin,leverage,bps),budget=p.lpCash*BigInt(config.lpPayoutFractionBps)/10000n;
      if(win>budget) {
        const lower=n*budget/(win||1n);
        if(lower>=t.minNotional)size(lower);
        else reasons.push('LP 可支付预算不足最低仓位；等待流动性，不借用 queued');
      }
    }
    if(config.autoStake&&unstaked.some(w=>conservativeMint(bps,rounds)+w.paper<stakeTarget))reasons.push('LP 缩仓后预计有钱包 PAPER 不足独立质押门槛');
    if(accumulating&&unstaked.length)projectedPaperAfterRounds=usd(unstaked.reduce((v,w)=>min(v,conservativeMint(bps,rounds)+w.paper),conservativeMint(bps,rounds)+unstaked[0]!.paper));
  }
  // Auto sizing must work in fixed-threshold mode as well. A cash shortage cannot override bust limits.
  if(config.autoLeverage&&WAD/BigInt(leverage)-m.bustBuffer<BigInt(bps+config.maxEntryGapBps+config.bustHeadroomBps)*WAD/10000n)reasons.push('所需自动杠杆无法覆盖平仓目标、最大开仓价差及强平缓冲，暂停新仓');
  const n=margin*BigInt(leverage),loss=n*BigInt(bps)/10000n;
  return {mode:config.strategyMode,phase:reasons.length?'paused':phase,canOpen:!reasons.length,reasons,closeMoveBps:bps,marginUsdc:usd(margin),leverage,costModeMaxHoldMinutes:config.costModeMaxHoldMinutes,costModeObjective:config.costModeObjective,
    notionalUsdc:usd(n),expectedPaper:costMode?.closeEfficiency?.projectedPaper??usd(estimatePaper(loss,p)),expectedNetLossUsdc:costMode?.closeEfficiency?.projectedCostUsdc??usd(estimateRoundCost(m,margin,leverage,bps+config.maxEntryGapBps)),mintRate:usd(mintRate(p)),
    lpCashUsdc:usd(p.lpCash),trackedLpUsdc:usd(p.paper.trackedLp),queuedUsdc:usd(p.queue),tailProgressUsdc:usd(p.paper.tail),sourceAt:p.sourceAt,sourceBlock:p.block,
    autoLeverage:config.autoLeverage,stakeTargetPaper:usd(stakeTarget),conservativePaper:usd(conservativeMint(bps)),plannedLossesPerWallet,projectedPaperAfterRounds,
    costPerPaperUsdc:costMode?.costPerPaperUsdc,estimatedHoldMinutes:costMode?.estimatedHoldMinutes,volatilityBpsPerSqrtMinute:costMode?.volatilityBpsPerSqrtMinute,
    volatilitySamples:costMode?.volatilitySamples,horizonSatisfied:costMode?.horizonSatisfied,
    closeEfficiency:costMode?.closeEfficiency,
    walletStakePlans:accumulating?stakePlans(ws,t.minPaperStake,stakeTarget,count=>conservativeMint(bps,count),plannedLossesPerWallet??0,config.slowCloseMaxLosses):undefined,walletSizing};
}
export function effectiveConfig(config:Config,decision:StrategyDecision):Config {
  return {...config,marginUsdc:decision.marginUsdc,leverage:decision.leverage,closeMoveBps:decision.closeMoveBps};
}

/** Reprice only an already-hedged pair. Never resize or open a position here. */
export function decideLiveClose(config:Config,t:Trading,m:Market,p:Protocol,ws:[Wallet,Wallet],positions:[Position,Position],ageMs:number,now=Date.now(),observedRangeBps:number|null=null,volatility:VolatilityEstimate|null=null,quoteMid:bigint|null=null,execution:EfficiencyContext=EMPTY_EFFICIENCY_CONTEXT) {
  if(config.strategyMode!=='lpAccumulating'||now-p.sourceAt>config.lpMaxAgeMs||p.sourceAt>now+5000||p.sourceAt<=0||positions.some(x=>x.margin<=0n||x.leverage<=0))return null;
  const notional=min(positions[0].margin*BigInt(positions[0].leverage),positions[1].margin*BigInt(positions[1].leverage));
  if(notional<=0n)return null;
  const unstaked=ws.filter(w=>w.staked===0n);
  const slow=unstaked.length>0&&(ageMs>=config.slowCloseForceAfterMs||ageMs>=config.slowCloseAfterMs&&observedRangeBps!==null&&observedRangeBps<=config.lowVolatilityRangeBps);
  const elapsedSteps=slow?Math.floor((ageMs-config.slowCloseAfterMs)/config.slowCloseStepMs):0;
  const low=unstaked.length?(slow?Math.max(config.slowCloseFloorBps,config.accumulationMinBps-5-2*elapsedSteps):config.accumulationMinBps):25;
  const high=unstaked.length?100:50;
  const target=t.minPaperStake*BigInt(config.stakeTargetBps)/10000n;
  const loss=(bps:number)=>notional*BigInt(Math.max(0,2*bps-config.maxEntryGapBps))/20000n;
  const mint=(bps:number,count=1)=>estimatePaper(loss(bps)*BigInt(count),p);
  const gapBps=entryGapBpsCeil([positions[0].entry,positions[1].entry]);
  const referencePaper=mint(50),referenceCost=estimateRoundCost(m,positions[0].margin,positions[0].leverage,50+gapBps);
  const safe=(bps:number)=>positions.every(pos=>bustDistanceBps(pos)>=BigInt(bps+gapBps+config.bustHeadroomBps));
  if(!unstaked.length) {
    if(!volatility)return null; // Preserve the persisted exit target during WS warm-up or reconnect.
    const entrySum=positions[0].entry+positions[1].entry;
    const currentMoveBps=quoteMid!==null&&entrySum>0n?Number(abs(2n*quoteMid-entrySum)*1000000n/entrySum)/100:0;
    const target=config.costModeObjective==='throughput'?selectEfficiencyTarget(config,m,p,positions,volatility,safe,ws,t.minPaperStake,ageMs,quoteMid,execution):
      selectCostModeTarget(config,m,p,positions[0].margin,positions[0].leverage,volatility,safe,currentMoveBps,gapBps);
    if(!target)return null;
    return {...target,plannedLossesPerWallet:null,conservativePaper:target.closeEfficiency?.projectedPaper??usd(mint(target.closeMoveBps)),projectedPaperAfterRounds:null,
      walletStakePlans:stakePlans(ws,t.minPaperStake,t.minPaperStake*BigInt(config.stakeTargetBps)/10000n,count=>mint(target.closeMoveBps,count),0,0),
      stakeTargetPaper:usd(t.minPaperStake*BigInt(config.stakeTargetBps)/10000n),expectedPaper:target.closeEfficiency?.projectedPaper??usd(estimatePaper(notional*BigInt(target.closeMoveBps)/10000n,p)),
      expectedNetLossUsdc:target.closeEfficiency?.projectedCostUsdc??usd(estimateRoundCost(m,positions[0].margin,positions[0].leverage,target.closeMoveBps+gapBps)),estimatedCostToStakeUsdc:null,
      sourceAt:p.sourceAt,sourceBlock:p.block,slowClose:false,observedRangeBps};
  }
  const needed=(bps:number,limit:number)=>{
    if(!config.autoStake)return 1;
    for(let count=1;count<=limit;count++)if(unstaked.every(w=>mint(bps,count)+w.paper>=target))return count;
    return null;
  };
  const baseRounds=unstaked.length===2?config.accumulationRounds:1;
  const base=unstaked.length?Array.from({length:101-config.accumulationMinBps},(_,i)=>config.accumulationMinBps+i)
    .map(bps=>({bps,rounds:safe(bps)?needed(bps,baseRounds):null})).find(x=>x.rounds!==null):null;
  const baseTotalCost=base&&base.rounds!==null?estimateRoundCost(m,positions[0].margin,positions[0].leverage,base.bps+gapBps)*BigInt(base.rounds):null;
  for(let bps=low;bps<=high;bps++) {
    if(!safe(bps))continue;
    const paper=mint(bps),cost=estimateRoundCost(m,positions[0].margin,positions[0].leverage,bps+gapBps);
    const rounds=unstaked.length?needed(bps,slow?config.slowCloseMaxLosses:baseRounds):null;
    if(unstaked.length&&rounds===null)continue;
    if(slow&&bps<config.accumulationMinBps&&(baseTotalCost===null||cost*BigInt(rounds!)*10000n>baseTotalCost*BigInt(10000+config.slowCloseCostToleranceBps)))continue;
    if(!unstaked.length&&(paper<=0n||referenceCost>0n&&cost*referencePaper*10000n>referenceCost*paper*BigInt(10000+config.costEfficiencyToleranceBps)))continue;
    const projected=rounds===null?null:usd(unstaked.reduce((v,w)=>min(v,mint(bps,rounds)+w.paper),mint(bps,rounds)+unstaked[0]!.paper));
    return {closeMoveBps:bps,plannedLossesPerWallet:rounds,conservativePaper:usd(paper),projectedPaperAfterRounds:projected,
      walletStakePlans:stakePlans(ws,t.minPaperStake,target,count=>mint(bps,count),rounds??0,config.slowCloseMaxLosses),
      stakeTargetPaper:usd(target),expectedPaper:usd(estimatePaper(notional*BigInt(bps)/10000n,p)),expectedNetLossUsdc:usd(cost),estimatedCostToStakeUsdc:rounds===null?null:usd(cost*BigInt(rounds)),
      sourceAt:p.sourceAt,sourceBlock:p.block,slowClose:slow,observedRangeBps,
      costPerPaperUsdc:undefined,estimatedHoldMinutes:null,volatilityBpsPerSqrtMinute:null,volatilitySamples:0,horizonSatisfied:false,closeEfficiency:undefined};
  }
  return null;
}
