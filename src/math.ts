import type { Config } from './config.js';
import { WAD, type Market, type Position, type Protocol, type Trading, type Wallet } from './types.js';
import { abs, amount, max, min, usd } from './util.js';

// Documented 2% win fee; actual settlements, not estimates, drive realized accounting.
export const WIN_FEE_NUMERATOR=2n;
export function netPnl(p:Position,price:bigint,m:Market):bigint {
  const delta=(price-p.entry)*(p.isLong?1n:-1n),notional=p.margin*BigInt(p.leverage);
  if(delta<=0n) return max(-p.margin,notional*delta/p.entry);
  const effective=delta-p.entry/50000n;
  if(effective<=0n) return 0n;
  const move=effective*WAD/p.entry;
  if(move<=0n) return 0n;
  const term1=WAD**3n/(move*m.rateMultiplier);
  const term2=m.referenceNotional*WAD**2n/(1_000_000n*move*m.positionMultiplier);
  const scale=(WAD-m.baseRate)*WAD/(WAD+term1+term2);
  const adjusted=(notional*effective/p.entry)*scale/WAD;
  return adjusted-adjusted*WIN_FEE_NUMERATOR/100n;
}
export function movedBeyond(price:bigint,entries:[bigint,bigint],bps=100):boolean {
  const sum=entries[0]+entries[1];
  if(sum<=0n) throw new Error('Invalid entry price');
  return abs(2n*price-sum)*10_000n>BigInt(bps)*sum;
}
/** Exit at the strategy move plus the exact spread between both fill prices. */
export function movedBeyondWithEntryGap(price:bigint,entries:[bigint,bigint],baseBps:number):boolean {
  const sum=entries[0]+entries[1];
  if(sum<=0n||!Number.isSafeInteger(baseBps)||baseBps<0)throw new Error('Invalid entry price or close target');
  return abs(2n*price-sum)*10_000n>BigInt(baseBps)*sum+abs(entries[0]-entries[1])*20_000n;
}
export function entryGapBpsCeil(entries:[bigint,bigint]):number {
  const sum=entries[0]+entries[1];
  if(sum<=0n)throw new Error('Invalid entry price');
  return Number((abs(entries[0]-entries[1])*20_000n+sum-1n)/sum);
}
export function entryGapTooLarge(entries:[bigint,bigint],bps:number):boolean {
  return abs(entries[0]-entries[1])*20_000n>BigInt(bps)*(entries[0]+entries[1]);
}
export function bustDistanceBps(p:Position):bigint {
  return (p.isLong?p.entry-p.bust:p.bust-p.entry)*10_000n/p.entry;
}
export function estimateRoundCost(m:Market,margin:bigint,leverage:number,bps:number):bigint {
  // Use a synthetic reference in the same units; integer rounding remains conservative.
  const entry=100_000_000n,exit=entry*(10_000n+BigInt(bps))/10_000n;
  const p:Position={id:'0',instrumentId:m.id,isLong:true,useDebt:false,entry,margin,leverage,bust:0n,openedAtMs:0,intentId:null};
  const raw=margin*BigInt(leverage)*BigInt(bps)/10_000n;
  return max(0n,raw-netPnl(p,exit,m));
}
export function estimatePaper(loss:bigint,protocol:Protocol):bigint {
  // Normal USD-funded close: empty queue carves 2% from eligible loss basis.
  const basis=protocol.queue===0n?loss-loss*2n/100n:loss;
  const c=protocol.paper;
  const flat=min(basis,max(0n,c.cliff-c.trackedLp)),tail=basis-flat;
  const mintedFlat=flat*c.rate/WAD;
  if(tail===0n) return mintedFlat;
  const h=c.tail,s=c.decay;
  // Integral of rate * (S/(S+H))² across this loss, rather than a marginal-rate multiplier.
  return mintedFlat+c.rate*s*s*tail/((s+h)*(s+h+tail)*WAD);
}
export function checkOpen(config:Config,trading:Trading,m:Market,wallets:Wallet[],price:bigint):string[] {
  const errors:string[]=[],margin=amount(config.marginUsdc),notional=margin*BigInt(config.leverage);
  if(trading.paused||!m.active||m.paused||m.retired||m.closeOnly) errors.push('市场停止开仓');
  if(trading.disabledActions.includes('openPosition')||trading.disabledActions.includes('closePositions')) errors.push('官方接入层暂停开仓或平仓');
  if(margin<trading.minMargin) errors.push(`保证金至少 ${usd(trading.minMargin)} USDC`);
  if(notional<trading.minNotional) errors.push(`单边名义本金至少 ${usd(trading.minNotional)} USDC`);
  if(notional>m.maxNotional||config.leverage>m.maxLeverage) errors.push('超过市场名义本金或杠杆限制');
  if(config.autoLeverage&&(config.leverage<config.minLeverage||config.leverage>config.maxLeverage))errors.push('自动杠杆超过配置范围');
  const required=BigInt(config.closeMoveBps+config.maxEntryGapBps+config.bustHeadroomBps)*WAD/10_000n;
  if(WAD/BigInt(config.leverage)-m.bustBuffer<required) errors.push(`杠杆过高，无法覆盖 ${config.closeMoveBps} bps 目标、最大开仓价差及强平缓冲`);
  if(config.capitalPerWalletUsdc!==null&&margin>amount(config.capitalPerWalletUsdc))errors.push('保证金超过单钱包资金上限');
  for(const w of wallets) {
    if(w.available<margin) errors.push(`${w.address} 可用 USDC 不足（不使用 queued）`);
    if(w.positions.length || w.operations.length) errors.push(`${w.address} 存在仓位或待处理请求`);
  }
  if(price<=0n) errors.push('没有有效 BBO 报价');
  else {
    const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
    const qty=ceil(notional*m.priceScale,price),buffer=amount(config.oiHeadroomUsdc),bufferQty=ceil(buffer*m.priceScale,price);
    if(m.longOi+qty>m.longCap||m.shortOi+qty>m.shortCap) errors.push('超过市场方向 OI 上限');
    else if(buffer>0n&&(m.longOi+qty+bufferQty>m.longCap||m.shortOi+qty+bufferQty>m.shortCap))errors.push('市场方向 OI 安全余量不足');
    const netOi=ceil(abs(m.longOi-m.shortOi)*price,m.priceScale);
    if(trading.maxNetOi>0n && netOi+notional>trading.maxNetOi) errors.push('临时单边敞口超过接入层净 OI 上限');
    else if(trading.maxNetOi>0n&&buffer>0n&&netOi+notional+buffer>trading.maxNetOi)errors.push('接入层净 OI 安全余量不足');
  }
  return errors;
}
/** Admit the more constrained direction first, so its definitive rejection sends no sibling order. */
export function chooseLeadOpenLeg(trading:Trading,m:Market,price:bigint,notional:bigint,sides:[boolean,boolean]):0|1 {
  if(price<=0n||sides[0]===sides[1])throw new Error('双边开仓需要有效报价及相反方向');
  const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d,qty=ceil(notional*m.priceScale,price),net=m.longOi-m.shortOi;
  const score=(isLong:boolean)=>{
    const direction=isLong?m.longCap-m.longOi-qty:m.shortCap-m.shortOi-qty;
    const directionUsdc=direction*price/m.priceScale;
    const netUsdc=trading.maxNetOi>0n?trading.maxNetOi-ceil(abs(net+(isLong?qty:-qty))*price,m.priceScale):directionUsdc;
    return min(directionUsdc,netUsdc);
  };
  return score(sides[0])<=score(sides[1])?0:1;
}
