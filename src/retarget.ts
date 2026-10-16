import type { Config } from './config.js';
import { bustDistanceBps, entryGapBpsCeil, estimatePaper, estimateRoundCost, movedBeyondWithEntryGap } from './math.js';
import { decideLiveClose, mintRate } from './strategy.js';
import type { Store } from './store.js';
import type { Market, Protocol, Quote, Round, Trading } from './types.js';
import { amount, min, usd } from './util.js';
import { PriceVolatility } from './volatility.js';
import { efficiencyContext } from './efficiency-data.js';

export interface RetargetInput {
  config: Config; trading: Trading; market: Market; protocol: Protocol; quote: Quote;
  roundId: number; expectedBps: number; targetBps: number; now: number;
  acceptImmediateClose?: boolean;
  allowUnchangedPolicy?: boolean;
}

export function inspectRetarget(store:Store,x:RetargetInput) {
  const r=store.activeRound(),reasons:string[]=[];
  if(!r||r.id!==x.roundId)reasons.push('活动轮次 ID 已改变');
  if(r?.state!=='hedged'||!r.strategy||r.legs.some(l=>!l.position||l.settled||l.closeIntent))reasons.push('轮次不再是两边已确认且尚未提交平仓的状态');
  const accumulating=x.config.strategyMode==='lpAccumulating';
  if(r?.strategy?.mode!=='lpDynamic'&&r?.strategy?.mode!=='lpAccumulating')reasons.push('仅支持已有 LP 动态策略轮次');
  const fromBps=r?.strategy?.closeMoveBps??null;
  if(fromBps!==x.expectedBps)reasons.push('原阈值已变化；请重新读取断点');
  if(!Number.isSafeInteger(x.targetBps)||x.targetBps<5||x.targetBps>x.expectedBps||x.targetBps===x.expectedBps&&!x.allowUnchangedPolicy)reasons.push('热更新仅允许把当前阈值调低到至少 5 bps');
  const minimum=accumulating?(r?.strategy?.phase==='activation'?x.config.accumulationMinBps:25):r?.strategy?.phase==='surplus'?100:r?.strategy?.phase==='fees'?50:25;
  if(x.targetBps<minimum)reasons.push(`新阈值低于当前阶段的 ${minimum} bps 基础值`);
  if(x.trading.paused||x.market.paused||x.market.retired||x.market.closeOnly||x.trading.disabledActions.includes('closePositions'))reasons.push('官方平仓入口或市场状态不可用');
  if(x.now-x.protocol.sourceAt>x.config.lpMaxAgeMs||x.protocol.sourceAt>x.now+5000)reasons.push('LP 快照过期或时钟异常');
  if(x.now-x.quote.receivedAt>x.config.quoteMaxAgeMs||x.now-x.quote.time>x.config.quoteMaxAgeMs||x.quote.time>x.now+2000||x.quote.mid<=0n)reasons.push('行情快照不新鲜');
  const runtime=store.get<{at:string;activeRoundId:number|null;phase:string;liveWallets:{current:boolean}[];tradingDataCurrent:boolean;lpDataCurrent:boolean}>('runtimeCheckpoint');
  if(!runtime||x.now-Date.parse(runtime.at)>5000||runtime.activeRoundId!==x.roundId||!['monitoring_hedge','monitoring_saved_hedge'].includes(runtime.phase)||!runtime.liveWallets?.every(w=>w.current)||!runtime.tradingDataCurrent||!runtime.lpDataCurrent)reasons.push('运行中进程尚未报告两个账户及交易数据均已同步');
  const wallets=store.snapshots();
  if(r&&wallets.length!==2||r?.legs.some(l=>!wallets.some(w=>w.address===l.wallet&&w.positions.some(p=>p.id===l.position?.id))))reasons.push('账户快照与持仓 ID 不匹配');
  const positions=r?.legs.map(l=>l.position).filter((p):p is NonNullable<typeof p>=>!!p)??[];
  const entries=positions.length===2?[positions[0]!.entry,positions[1]!.entry] as [bigint,bigint]:null;
  const gapBps=entries?entryGapBpsCeil(entries):0;
  for(const p of positions)if(bustDistanceBps(p)<BigInt(x.targetBps+gapBps+x.config.bustHeadroomBps))reasons.push('新阈值与强平缓冲不匹配');
  const notional=r?.strategy?amount(r.strategy.marginUsdc)*BigInt(r.strategy.leverage):0n;
  const loss=notional*BigInt(Math.max(0,2*x.targetBps-x.config.maxEntryGapBps))/20000n;
  const conservativePaper=estimatePaper(loss,x.protocol),paperTarget=x.trading.minPaperStake*BigInt(x.config.stakeTargetBps)/10000n;
  const unstaked=accumulating?wallets.filter(w=>w.staked===0n):wallets;
  const loosePaper=unstaked.length?unstaked.reduce((a,w)=>min(a,w.paper),unstaked[0]!.paper):0n;
  const plannedLossesPerWallet=accumulating&&unstaked.length===wallets.length?x.config.accumulationRounds:1;
  const projectedPaper=estimatePaper(loss*BigInt(plannedLossesPerWallet),x.protocol)+loosePaper;
  if(x.config.autoStake&&unstaked.length&&projectedPaper<paperTarget)reasons.push('新阈值预计 PAPER 未达到配置的累计质押目标');
  const wouldClose=entries&&x.quote.mid>0n?movedBeyondWithEntryGap(x.quote.mid,entries,x.targetBps):null;
  if(wouldClose&&!x.acceptImmediateClose)reasons.push('当前报价已越过新阈值；如确要立即触发平仓，须显式允许');
  const oldCost=r?.strategy?.expectedNetLossUsdc??null;
  return {allowed:reasons.length===0,reasons,roundId:r?.id??null,roundState:r?.state??null,fromBps,toBps:x.targetBps,wouldCloseAtCurrentQuote:wouldClose,
    quoteTime:new Date(x.quote.time).toISOString(),quoteMidRaw:String(x.quote.mid),protocolBlock:x.protocol.block,protocolSourceAt:new Date(x.protocol.sourceAt).toISOString(),
    estimatedConservativePaper:usd(conservativePaper),plannedLossesPerWallet:accumulating&&unstaked.length?plannedLossesPerWallet:null,projectedPaperAfterRounds:accumulating&&unstaked.length?usd(projectedPaper):null,
    requiredPaper:usd(paperTarget),estimatedNetLossUsdc:r?.strategy?usd(estimateRoundCost(x.market,amount(r.strategy.marginUsdc),r.strategy.leverage,x.targetBps+gapBps)):null,previousEstimatedNetLossUsdc:oldCost};
}

export type EfficiencyRetargetInput=Omit<RetargetInput,'targetBps'|'allowUnchangedPolicy'>;
export function inspectEfficiencyRetarget(store:Store,x:EfficiencyRetargetInput) {
  const r=store.activeRound(),wallets=store.snapshots(),positions=r?.legs.map(l=>l.position)??[];
  const valid=positions.length===2&&positions.every(Boolean)&&wallets.length===2&&wallets.every(w=>w.staked>0n);
  const volatility=new PriceVolatility(store.get('priceMinutes')??[]).estimate(x.now);
  const optimization=valid?decideLiveClose({...x.config,costModeObjective:'throughput',costModeMaxHoldMinutes:null},x.trading,x.market,x.protocol,
    wallets as [typeof wallets[0],typeof wallets[0]],positions as [NonNullable<typeof positions[0]>,NonNullable<typeof positions[0]>],
    x.now-Math.max(...positions.map(p=>p!.openedAtMs)),x.now,null,volatility,x.quote.mid,efficiencyContext(store,x.config,x.now)):null;
  const target=optimization?.closeMoveBps??x.expectedBps;
  const preview=inspectRetarget(store,{...x,targetBps:target,allowUnchangedPolicy:true});
  if(!valid)preview.reasons.push('效率模式要求两个钱包都已质押且两侧仓位完整');
  if(!optimization?.closeEfficiency)preview.reasons.push('没有新鲜 BTC 样本或成本边界内的安全候选');
  return {...preview,allowed:preview.reasons.length===0,optimization};
}
/** Adopt the new policy and lower only this round's exit target; no order is signed here. */
export function applyEfficiencyRetarget(store:Store,x:EfficiencyRetargetInput) {
  return store.transaction(()=>{
    const preview=inspectEfficiencyRetarget(store,{...x,now:Date.now()});
    if(!preview.allowed||!preview.optimization?.closeEfficiency)throw new Error(`无法热更新效率策略：${preview.reasons.join('; ')}`);
    const r=store.activeRound()!,old=r.strategy!,live=preview.optimization;
    r.manualRetargets=[...(r.manualRetargets??[]),{at:Date.now(),fromBps:old.closeMoveBps,toBps:live.closeMoveBps,protocolBlock:x.protocol.block,quoteMidRaw:String(x.quote.mid)}];
    r.strategy={...old,mode:'lpAccumulating',costModeObjective:'throughput',costModeMaxHoldMinutes:null,closeMoveBps:live.closeMoveBps,
      expectedPaper:live.expectedPaper,expectedNetLossUsdc:live.expectedNetLossUsdc,conservativePaper:live.conservativePaper,
      costPerPaperUsdc:live.costPerPaperUsdc,estimatedHoldMinutes:live.estimatedHoldMinutes,volatilityBpsPerSqrtMinute:live.volatilityBpsPerSqrtMinute,
      volatilitySamples:live.volatilitySamples,horizonSatisfied:true,closeEfficiency:live.closeEfficiency,walletStakePlans:live.walletStakePlans,
      mintRate:usd(mintRate(x.protocol)),lpCashUsdc:usd(x.protocol.lpCash),trackedLpUsdc:usd(x.protocol.paper.trackedLp),queuedUsdc:usd(x.protocol.queue),
      tailProgressUsdc:usd(x.protocol.paper.tail),sourceAt:x.protocol.sourceAt,sourceBlock:x.protocol.block};
    store.saveRound(r);
    return {...preview,committedAt:new Date().toISOString(),auditEntries:r.manualRetargets.length};
  });
}

/** Atomically modify only the persisted close threshold, with a durable audit record. */
export function applyRetarget(store:Store,x:RetargetInput) {
  return store.transaction(()=>{
    const preview=inspectRetarget(store,{...x,now:Date.now()});
    if(!preview.allowed)throw new Error(`无法热更新：${preview.reasons.join('; ')}`);
    const r=store.activeRound() as Round;
    const old=r.strategy!;
    const nominal=amount(old.marginUsdc)*BigInt(old.leverage);
    const normalLoss=nominal*BigInt(x.targetBps)/10000n;
    r.manualRetargets=[...(r.manualRetargets??[]),{at:Date.now(),fromBps:old.closeMoveBps,toBps:x.targetBps,protocolBlock:x.protocol.block,quoteMidRaw:String(x.quote.mid)}];
    r.strategy={...old,mode:x.config.strategyMode==='lpAccumulating'?'lpAccumulating':old.mode,closeMoveBps:x.targetBps,expectedPaper:usd(estimatePaper(normalLoss,x.protocol)),conservativePaper:preview.estimatedConservativePaper,
      plannedLossesPerWallet:preview.plannedLossesPerWallet??undefined,projectedPaperAfterRounds:preview.projectedPaperAfterRounds??undefined,
      stakeTargetPaper:preview.requiredPaper,expectedNetLossUsdc:preview.estimatedNetLossUsdc!,mintRate:usd(mintRate(x.protocol)),
      lpCashUsdc:usd(x.protocol.lpCash),trackedLpUsdc:usd(x.protocol.paper.trackedLp),queuedUsdc:usd(x.protocol.queue),tailProgressUsdc:usd(x.protocol.paper.tail),sourceAt:x.protocol.sourceAt,sourceBlock:x.protocol.block};
    store.saveRound(r);
    return {...preview,committedAt:new Date().toISOString(),auditEntries:r.manualRetargets.length};
  });
}
