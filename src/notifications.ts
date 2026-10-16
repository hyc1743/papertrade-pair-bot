import type { Address } from 'viem';
import type { TradingApi } from './api.js';
import { netPnl } from './math.js';
import type { Store } from './store.js';
import type { Market, Quote } from './types.js';
import type { Config } from './config.js';
import type { StrategyDecision, Wallet } from './types.js';
import { amount } from './util.js';
import { log } from './util.js';

/** Signed WAD amount, rounded half away from zero to two display decimals. */
export function formatAmount2(value:bigint):string {
  const cents=((value<0n?-value:value)+5_000_000_000_000_000n)/10_000_000_000_000_000n;
  return `${value<0n&&cents>0n?'-':''}${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
}

export type TradeNoticeKind='open_submitted'|'open_hedged'|'close_submitted'|'round_settled'|'margin_warning';
interface Notice {
  key:string; kind:TradeNoticeKind; roundId:number; createdAt:number;
  body:string; attempts:number; nextAttemptAt:number;
}
const labels:Record<TradeNoticeKind,string>={open_submitted:'开仓请求已发起',open_hedged:'双边开仓确认',close_submitted:'平仓请求已发起',round_settled:'平仓已结算',margin_warning:'保证金或强平缓冲不足'};
const MARGIN_WARNING_INTERVAL_MS=30*60*1000;

/** Durable, non-blocking Bark delivery. No device key is written to SQLite or logs. */
export class TradeNotifier {
  private job:Promise<void>|null=null;
  private endpoint:URL|null=null;
  private deviceKey:string|null=null;
  constructor(private store:Store,private api:TradingApi,private addresses:[Address,Address],
    private market:()=>Market|null,private quote:()=>Quote|null,baseUrl=process.env.PAPERTRADE_BARK_URL??'',
    private fetcher:typeof fetch=fetch,private now:()=>number=Date.now) {
    if(!baseUrl)return;
    const u=new URL(baseUrl),parts=u.pathname.split('/').filter(Boolean),key=parts.at(-1);
    if(u.protocol!=='https:'||!key||u.username||u.password||u.search||u.hash)throw new Error('PAPERTRADE_BARK_URL 必须是 HTTPS 设备 URL');
    this.endpoint=new URL('/push',u);this.deviceKey=key;
  }
  queue(kind:TradeNoticeKind,roundId:number):void {
    if(!this.endpoint)return;
    const key=`${roundId}:${kind}`;
    if(this.store.get<boolean>(`barkSent:${key}`)||this.store.get<Notice>(`barkNotice:${key}`))return;
    const round=this.store.rounds().find(r=>r.id===roundId),wallets=this.store.snapshots();
    const q=this.quote(),m=this.market();
    const pnl=round?.legs.reduce((sum,leg)=>sum+(leg.settled?.netPnl??(leg.position&&q&&m?netPnl(leg.position,q.mid,m):0n)),0n)??0n;
    const minted=round?.legs.reduce((sum,leg)=>sum+(leg.settled?.paper??0n),0n)??0n;
    const lines=[`轮次 #${roundId} · ${labels[kind]}`,`两边合计 PNL：${formatAmount2(pnl)} USDC`,`本轮已结算 PAPER：${formatAmount2(minted)}`];
    for(const [index,address] of this.addresses.entries()) {
      const w=wallets.find(w=>w.address===address);
      lines.push(w?`钱包 ${index===0?'A':'B'} (${address.slice(0,6)}…${address.slice(-4)})：余额 ${formatAmount2(w.balance)} USDC，可用 ${formatAmount2(w.available)}，锁定 ${formatAmount2(w.locked)}；PAPER ${formatAmount2(w.paper)}，已质押 ${formatAmount2(w.staked)}；累计已领分红 ${formatAmount2(w.claimedRewards)} USDC`:
        `钱包 ${index===0?'A':'B'}：账户快照暂不可用`);
    }
    const notice:Notice={key,kind,roundId,createdAt:this.now(),body:lines.join('\n'),attempts:0,nextAttemptAt:this.now()};
    this.store.transaction(()=>{this.store.set(`barkNotice:${key}`,notice);this.store.set('barkQueue',[...new Set([...(this.store.get<string[]>('barkQueue')??[]),key])]);});
    this.pump();
  }
  /** Warn only for funding/liquidation blockers, not OI, LP, or connectivity waits. */
  queueMarginWarning(config:Config,decision:StrategyDecision,market:Market,wallets:Wallet[],reasons:string[]):void {
    if(!this.endpoint)return;
    const margin=amount(decision.marginUsdc),notional=amount(decision.notionalUsdc);
    const available=this.addresses.map(address=>wallets.find(w=>w.address===address)?.available??null);
    const cashShort=available.map(v=>v!==null&&v<margin);
    const fundingBlocked=reasons.some(r=>/保证金预算|可交易现金不足|资金所需|保证金至少|可用 USDC 不足|保证金超过单钱包资金上限|保证金预算为零/.test(r));
    const bustBlocked=reasons.some(r=>/杠杆过高|自动杠杆无法覆盖|强平缓冲，暂停新仓/.test(r));
    if(!fundingBlocked&&!bustBlocked&&!cashShort.some(Boolean)){
      if(this.store.get('barkMarginWarningState'))this.store.set('barkMarginWarningState',null);
      return;
    }
    const requiredBps=decision.closeMoveBps+config.maxEntryGapBps+config.bustHeadroomBps;
    const safeNumerator=10_000n*10n**18n;
    const safeDenominator=BigInt(requiredBps)*10n**18n+market.bustBuffer*10_000n;
    const safeLeverage=safeDenominator>0n?Number(safeNumerator/safeDenominator):0;
    // A cash-constrained decision may shrink its notional; report the intended
    // target, not the unaffordable fallback, or the alert understates the gap.
    const target=config.targetNotionalUsdc!==null?amount(config.targetNotionalUsdc):notional;
    const allowedLeverage=Math.min(safeLeverage,config.maxLeverage,market.maxLeverage);
    const minimumMargin=allowedLeverage>0?(target+BigInt(allowedLeverage)-1n)/BigInt(allowedLeverage):0n;
    const requiredAvailable=config.autoLeverage&&config.marginUtilizationBps>0?
      (minimumMargin*10_000n+BigInt(config.marginUtilizationBps)-1n)/BigInt(config.marginUtilizationBps):minimumMargin;
    const flags=[fundingBlocked?'funding':'',bustBlocked?'bust':'',...cashShort.map((v,i)=>v?`wallet${i}`:'')].filter(Boolean).join(':');
    const previous=this.store.get<{flags:string;at:number}>('barkMarginWarningState');
    const now=this.now();
    if(previous?.flags===flags&&now-previous.at<MARGIN_WARNING_INTERVAL_MS)return;
    const lines=[labels.margin_warning,`开仓已暂停；原因：${reasons.filter(r=>/保证金|可交易现金|资金所需|杠杆过高|强平缓冲|可用 USDC/.test(r)).join('；')}`,
      `目标单边名义仓位：${formatAmount2(target)} USDC；本轮保证金：${formatAmount2(margin)} USDC；杠杆：${decision.leverage}x`,
      `平仓基础目标：${decision.closeMoveBps} bps；最大开仓价差：${config.maxEntryGapBps} bps；额外强平缓冲：${config.bustHeadroomBps} bps；市场强平扣减：${formatAmount2(market.bustBuffer*10_000n)} bps`,
      `该目标最高安全杠杆：${allowedLeverage}x；对应最低保证金：${formatAmount2(minimumMargin)} USDC；按资金利用率需每钱包可用 ${formatAmount2(requiredAvailable)} USDC`];
    for(const [i,address] of this.addresses.entries()) {
      const w=wallets.find(x=>x.address===address);
      lines.push(w?`钱包 ${i===0?'A':'B'} (${address.slice(0,6)}…${address.slice(-4)})：余额 ${formatAmount2(w.balance)} USDC，可用 ${formatAmount2(w.available)} USDC，缺口 ${formatAmount2(w.available<requiredAvailable?requiredAvailable-w.available:0n)} USDC，锁定 ${formatAmount2(w.locked)} USDC；PAPER ${formatAmount2(w.paper)}，已质押 ${formatAmount2(w.staked)}；累计已领分红 ${formatAmount2(w.claimedRewards)} USDC`:`钱包 ${i===0?'A':'B'}：账户快照暂不可用`);
    }
    const key=`margin:${now}`,notice:Notice={key,kind:'margin_warning',roundId:0,createdAt:now,body:lines.join('\n'),attempts:0,nextAttemptAt:now};
    this.store.transaction(()=>{this.store.set(`barkNotice:${key}`,notice);this.store.set('barkQueue',[...new Set([...(this.store.get<string[]>('barkQueue')??[]),key])]);this.store.set('barkMarginWarningState',{flags,at:now});});
    this.pump();
  }
  pump():void {
    if(!this.endpoint||this.job)return;
    const keys=this.store.get<string[]>('barkQueue')??[];
    const notice=keys.map(key=>this.store.get<Notice>(`barkNotice:${key}`)).find(n=>n&&n.nextAttemptAt<=this.now());
    if(!notice)return;
    this.job=this.send(notice).finally(()=>{this.job=null;});
  }
  async shutdown():Promise<void> {if(this.job)await this.job;}
  private async send(notice:Notice):Promise<void> {
    const rewardLines=await Promise.all(this.addresses.map(async(address,index)=>{
      try {return `钱包 ${index===0?'A':'B'} 当前可领取分红：${formatAmount2(await this.api.pendingReward(address,AbortSignal.timeout(2500)))} USDC`;}
      catch {return `钱包 ${index===0?'A':'B'} 当前可领取分红：读取失败`;} 
    }));
    try {
      const response=await this.fetcher(this.endpoint!,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({device_key:this.deviceKey,title:notice.kind==='margin_warning'?'Papertrade 保证金预警':`Papertrade #${notice.roundId} ${labels[notice.kind]}`,body:[notice.body,...rewardLines].join('\n'),group:'Papertrade'}),
        signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!response.ok)throw new Error('Bark 返回非成功状态');
      const data=await response.json().catch(()=>null) as {code?:number}|null;
      if(data?.code!==undefined&&data.code!==200)throw new Error('Bark 拒绝推送');
      this.store.transaction(()=>{
        this.store.set(`barkSent:${notice.key}`,true);
        this.store.set(`barkNotice:${notice.key}`,null);
        this.store.set('barkQueue',(this.store.get<string[]>('barkQueue')??[]).filter(x=>x!==notice.key));
      });
      log('bark_notification_sent',{round:notice.roundId,kind:notice.kind});
    } catch {
      notice.attempts++;
      notice.nextAttemptAt=this.now()+Math.min(60000,1000*2**Math.min(notice.attempts,6));
      this.store.set(`barkNotice:${notice.key}`,notice);
      log('bark_notification_retry',{round:notice.roundId,kind:notice.kind,attempts:notice.attempts});
    }
  }
}
