import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { Config } from './config.js';
import { ApiError, type TradingApi } from './api.js';
import { Store } from './store.js';
import { decryptSession, encryptSession, newSession, signIntent, type Identity, type Session } from './signing.js';
import { Quotes, WalletStream, type QuoteSource, type WalletSource } from './streams.js';
import { bustDistanceBps, checkOpen, chooseLeadOpenLeg, entryGapBpsCeil, entryGapTooLarge, estimateRoundCost, movedBeyondWithEntryGap, netPnl } from './math.js';
import { amount, delay, errorText, log, max, min, usd } from './util.js';
import { ZERO, type Intent, type Market, type Protocol, type Quote, type Round, type Trading, type Wallet } from './types.js';
import { decideLiveClose, decideStrategy, effectiveConfig } from './strategy.js';
import { isReward, Rewards } from './rewards.js';
import type { StrategyDecision } from './types.js';
import { openingSchedule } from './schedule.js';
import { readCheckpoint } from './checkpoint.js';
import { TradeNotifier } from './notifications.js';
import { PriceVolatility, type MinutePrice } from './volatility.js';
import { OiStabilityGate } from './oi-guard.js';
import { efficiencyContext, recordCurveMinute, recordExecutionTiming } from './efficiency-data.js';

export const terminal=(i:Intent|null)=>!!i&&['succeeded','failed','expired','cancelled'].includes(i.state);
interface EngineOptions {
  now?:()=>number;
  sources?:Map<Address,WalletSource>;
  quotes?:QuoteSource;
  rewardsOnly?:boolean;
}
export class Engine {
  readonly sources:Map<Address,WalletSource>;
  readonly rewards:Rewards;
  readonly notifier:TradeNotifier;
  private readonly volatility:PriceVolatility;
  private readonly oiGate=new OiStabilityGate();
  quotes:QuoteSource|null;
  trading:Trading|null=null; protocol:Protocol|null=null; market:Market|null=null;
  failureReason:string|null=null;
  private stopRequested=false; private tradingAt=0; private protocolAt=0; private startedAt:number;
  private tradingReadStartedAt=0;
  private sessionBackoff=new Map<Address,number>(); private cancelBackoff=new Map<Hex,number>();
  private closeBackoff=new Map<Address,number>();
  private historyAt=0; private lastWait='';
  private lastWaitAt=0;
  private hedgedDataGap:{roundId:number;startedAt:number}|null=null;
  private openingDataGap:{roundId:number;startedAt:number}|null=null;
  private lastTradingError:string|null=null;
  private tradeStoppedReason:string|null=null;
  private readonly rewardsOnly:boolean;
  private lpLoopRunning=false;
  private lpAbort=new AbortController();
  private lpLoop:Promise<void>|null=null;
  private lastLpAttemptAt=0;
  private protocolHealthy=false; private tradingHealthy=false;
  private jobs=new Map<string,Promise<void>>();
  private tradingAbort=new AbortController();
  private tradingRetryAt=0; private nonceReadAt=new Map<Hex,number>();
  private lastOpenWaitAt=0;
  private closeWaitAt=new Map<Address,number>();
  private quoteWindow:{at:number;mid:bigint}[]=[];
  private lastCloseTargetReportAt=0;
  private readonly startupPendingIds:Hex[];
  private readonly startupActiveRoundId:number|null;
  private readonly checkpointLoadedAt:number;
  private lastCheckpointPhase:string|null=null;
  readonly now:()=>number;
  constructor(readonly config:Config,readonly identities:[Identity,Identity],readonly store:Store,readonly api:TradingApi,options:EngineOptions={}) {
    this.now=options.now??Date.now;this.startedAt=this.now();this.quotes=options.quotes??null;
    this.sources=options.sources??new Map(identities.map(i=>[i.address,new WalletStream(i.address,w=>this.observe(w))]));
    this.rewardsOnly=options.rewardsOnly??false;
    if(this.rewardsOnly&&store.activeRound())throw new Error('存在脚本仓位，请先 run --live 恢复；rewards 模式不处理交易仓位');
    const checkpoint=readCheckpoint(store,this.now());
    if(checkpoint.integrityErrors.length)throw new Error(`状态库断点完整性检查失败：${checkpoint.integrityErrors.join('; ')}`);
    this.startupPendingIds=checkpoint.pendingIntents.map(i=>i.id);
    this.startupActiveRoundId=checkpoint.activeRound?.id??null;
    this.checkpointLoadedAt=this.now();
    this.volatility=new PriceVolatility(store.get<MinutePrice[]>('priceMinutes')??[]);
    const savedDataGap=store.get<{roundId:number;startedAt:number}>('activeDataGap');
    if(savedDataGap?.roundId===this.startupActiveRoundId)this.hedgedDataGap=savedDataGap;
    else if(savedDataGap)store.set('activeDataGap',null);
    const savedOpeningGap=store.get<{roundId:number;startedAt:number}>('activeOpeningDataGap');
    if(savedOpeningGap?.roundId===this.startupActiveRoundId&&checkpoint.activeRound?.state==='opening')this.openingDataGap=savedOpeningGap;
    else if(savedOpeningGap)store.set('activeOpeningDataGap',null);
    store.bind(identities.map(i=>i.address),config.market);
    store.set('checkpointStartup',{loadedAt:new Date(this.checkpointLoadedAt).toISOString(),nextAction:checkpoint.nextAction,priorStopRequested:checkpoint.stopRequested,priorTradeStoppedReason:checkpoint.tradeStoppedReason,activeRoundId:checkpoint.activeRound?.id??null,pendingIntents:checkpoint.pendingIntents.length,accounts:checkpoint.accounts.length});
    log('checkpoint_loaded',{nextAction:checkpoint.nextAction,activeRoundId:checkpoint.activeRound?.id??null,pendingIntents:checkpoint.pendingIntents.length,accounts:checkpoint.accounts.length});
    store.set('stopRequested',false);
    store.set('tradeStoppedReason',null);
    const schedule=openingSchedule(config.openingAtUtc,config.openingCheckLeadMs,this.now());
    store.set('openingSchedule',{openingAtUtc:config.openingAtUtc,checkAtUtc:schedule.checkAt===null?null:new Date(schedule.checkAt).toISOString()});
    this.protocol=store.get<{protocol:Protocol}>('protocolSnapshot')?.protocol??null;
    this.rewards=new Rewards(config,identities,store,api,()=>({wallets:[...this.sources.values()].flatMap(s=>s.latest?[s.latest]:[]),current:wallet=>this.walletCurrent(wallet),trading:this.trading,tradingAt:this.tradingAt,allowed:!this.stopRequested&&!store.get<boolean>('stopRequested')&&(this.rewardsOnly||openingSchedule(config.openingAtUtc,config.openingCheckLeadMs,this.now()).canOpen)}),i=>this.submit(i),this.now);
    this.notifier=new TradeNotifier(store,api,identities.map(i=>i.address) as [Address,Address],()=>this.market,()=>this.quotes?.latest??null,process.env.PAPERTRADE_BARK_URL??'',fetch,this.now);
    if(this.rewardsOnly)this.haltTrading('仅监控质押分配');
    const r=store.activeRound();
    if(r?.state==='recovering')this.haltTrading(r.reason??'重启继续退出存量仓位');
    if(checkpoint.unresolvedOwnership)this.haltTrading('历史仓位归属尚未核实，禁止新交易');
    if(r?.state==='opening'&&r.legs.some(l=>store.intent(l.openIntent)?.state==='prepared')) {
      // An unattempted sibling may not be sent after restart. Cancel locally and exit any confirmed inventory.
      for(const i of store.intents(r.id))if(i.action==='openPosition'&&i.state==='prepared')store.updateIntent(i.id,'cancelled');
      this.recover('重启恢复未完成的开仓：存在从未提交的对冲侧');
    }
    // If both open requests crossed the I/O boundary, preserve the original IDs and wait for
    // authoritative wallet data. A restart must neither resend them nor start a new round.
    this.saveRuntimeCheckpoint();
  }
  private saveRuntimeCheckpoint(forcedPhase?:string):void {
    const round=this.store.activeRound(),live=this.identities.map(i=>({wallet:i.address,current:this.walletCurrent(i.address),indexedBlock:this.sources.get(i.address)?.latest?.block??null}));
    const outstanding=this.startupPendingIds.filter(id=>{const i=this.store.intent(id);return i&&!terminal(i);});
    const savedRound=round?.id===this.startupActiveRoundId;
    const phase=forcedPhase??(this.store.get('unresolvedOwnership')?'manual_review':live.some(w=>!w.current)?'waiting_live_snapshots':round?.state==='recovering'?'exiting_owned_positions':outstanding.length?'reconciling_saved_requests':round?.state==='opening'?(savedRound?'waiting_saved_open':'opening'):round?.state==='hedged'?(savedRound?'monitoring_saved_hedge':'monitoring_hedge'):round?.state==='closing'?(savedRound?'waiting_saved_close':'waiting_close'):this.stopRequested?'stop_requested':this.tradeStoppedReason?'trade_halted_rewards_only':'ready');
    this.store.set('runtimeCheckpoint',{at:new Date(this.now()).toISOString(),loadedAt:new Date(this.checkpointLoadedAt).toISOString(),phase,activeRoundId:round?.id??null,activeRoundState:round?.state??null,outstandingSavedRequests:outstanding.length,liveWallets:live,tradingDataCurrent:this.tradingHealthy&&this.now()-this.tradingAt<=5000,lpDataCurrent:this.protocolHealthy&&this.now()-this.protocolAt<=this.config.lpMaxAgeMs,tradeStoppedReason:this.tradeStoppedReason,stopRequested:this.stopRequested});
    if(phase!==this.lastCheckpointPhase){this.lastCheckpointPhase=phase;log('checkpoint_progress',{phase,activeRoundId:round?.id??null,outstandingSavedRequests:outstanding.length});}
  }
  observe(w:Wallet):void {
    if(!this.identities.some(i=>i.address===w.address))throw new Error('Foreign account stream');
    if(this.store.get<string>(`baseline:${w.address}`)===null)this.store.set(`baseline:${w.address}`,String(w.realizedPnl));
    if(this.store.get<string>(`claimedBaseline:${w.address}`)===null)this.store.set(`claimedBaseline:${w.address}`,String(w.claimedRewards));
    this.store.transaction(()=>{
      this.store.snapshot(w);
      const previous=this.store.get<{reserved:bigint;claimed:bigint;withdrawn:bigint}>(`rewardReserve:${w.address}`);
      let reserved=previous?.reserved??0n;
      if(previous) {
        reserved+=max(0n,w.claimedRewards-previous.claimed);
        // Manual withdrawals consume the logical reward reserve first; no funds are moved by this bot.
        reserved=max(0n,reserved-max(0n,w.withdrawn-previous.withdrawn));
      }
      this.store.set(`rewardReserve:${w.address}`,{reserved,claimed:w.claimedRewards,withdrawn:w.withdrawn});
      for(const outcome of w.outcomes) {
        const i=this.store.intent(outcome.id);
        if(i?.wallet===w.address && outcome.outcome!=='unknown') {
          this.store.updateIntent(i.id,outcome.outcome);
          if(i.action==='paperClaim'&&outcome.outcome==='succeeded')this.store.set(`pendingReward:${w.address}`,{amount:0n,checkedAt:this.now()});
        }
      }
      for(const op of w.operations) {
        const i=this.store.intent(op.id);
        if(i?.wallet===w.address&&!terminal(i))this.store.updateIntent(i.id,'queued');
      }
      for(const p of w.positions) {
        if(!p.intentId)continue;
        const i=this.store.intent(p.intentId);
        if(!i || i.wallet!==w.address || i.action!=='openPosition' || i.round===null)continue;
        if(String(i.signed.size)!==String(p.margin)||Number(i.signed.leverage)!==p.leverage||Number(i.signed.instrumentId)!==p.instrumentId||i.signed.isLong!==p.isLong||p.useDebt)throw new Error('Observed position differs from persisted signed intent');
        const r=this.store.rounds().find(r=>r.id===i.round);
        if(!r)throw new Error('Missing round for owned position');
        const leg=r.legs.find(l=>l.wallet===w.address&&l.openIntent===i.id);
        if(!leg || leg.position&&leg.position.id!==p.id)throw new Error('Owned position identity mismatch');
        leg.position=p;
        r.firstFillAt=Math.min(r.firstFillAt??Infinity,Math.max(r.createdAt,Math.min(this.now(),p.openedAtMs)));
        this.store.saveRound(r);this.store.updateIntent(i.id,'succeeded');
      }
      for(const observed of w.closed) {
        const p={...observed,closedAtMs:observed.closedAtMs??w.timestamp*1000};
        const r=this.store.rounds().find(r=>r.legs.some(l=>l.wallet===w.address&&l.position?.id===p.id));
        if(!r)continue; // Never infer ownership by direction/size/time.
        const leg=r.legs.find(l=>l.wallet===w.address&&l.position?.id===p.id)!;
        p.openedAtMs=observed.openedAtMs??leg.position?.openedAtMs;
        this.store.record(w.address,r.id,p);leg.settled=p;this.store.saveRound(r);
        if(leg.closeIntent)this.store.updateIntent(leg.closeIntent,'succeeded');
      }
    });
    queueMicrotask(()=>this.rewards.wake());
  }
  requestStop(reason='用户停止'):void { this.stopRequested=true;this.store.set('stopRequested',true);this.store.set('lastStopReason',reason); }
  private recover(reason:string):void {
    this.failureReason??=reason;this.haltTrading(reason);
    const r=this.store.activeRound();if(r) {
      if(r.state!=='recovering'||r.reason!==reason)log('round_recovering',{round:r.id,reason,elapsedMs:this.now()-r.createdAt,openTimeoutMs:this.config.openTimeoutMs,legs:r.legs.map(l=>({wallet:l.wallet,openState:this.store.intent(l.openIntent)?.state,positionId:l.position?.id??null,settled:!!l.settled}))});
      r.state='recovering';r.reason=reason;this.store.saveRound(r);
    }
  }
  private haltTrading(reason:string):void {
    this.tradeStoppedReason=reason;this.store.set('tradeStoppedReason',reason);
    if(!this.config.keepRewardsMonitoring&&!this.rewardsOnly)this.requestStop(reason);
  }
  private wait(reason:string) {if(reason!==this.lastWait||this.now()-this.lastWaitAt>=30000){log('waiting',{reason});this.lastWait=reason;this.lastWaitAt=this.now();}}
  private background(key:string,work:()=>Promise<void>):void {
    if(this.jobs.has(key))return;
    const job=work().catch(e=>this.wait(`后台任务 ${key.split(':')[0]}：${errorText(e)}`)).finally(()=>this.jobs.delete(key));
    this.jobs.set(key,job);
  }
  async drainBackground():Promise<void> {while(this.jobs.size)await Promise.all([...this.jobs.values()]);}
  private dispatch(i:Intent):void {this.background(`submit:${i.id}`,()=>this.submit(i));}
  private refreshTrading():void {
    if(this.now()<this.tradingRetryAt||this.tradingAbort.signal.aborted)return;
    this.background('trading',async()=>{
      const started=this.now();
      try {
        const updated=await this.api.trading(this.tradingAbort.signal);
        if(this.trading&&updated.block<this.trading.block)throw new Error('交易状态索引回退');
        const market=updated.markets.find(m=>m.symbol===this.config.market);if(!market)throw new Error('Selected market is missing');
        this.trading=updated;this.market=market;this.tradingAt=this.now();this.tradingReadStartedAt=started;this.tradingHealthy=true;this.lastTradingError=null;
        this.store.set('tradingHealth',{healthy:true,checkedAt:this.now(),block:updated.block});
        if(!this.quotes&&!this.rewardsOnly){this.quotes=new Quotes(market);this.quotes.start();}
        this.rewards.wake();
      }catch(e){this.tradingHealthy=false;this.lastTradingError=errorText(e);this.store.set('tradingHealth',{healthy:false,checkedAt:this.now(),reason:this.lastTradingError});if(e instanceof ApiError)this.tradingRetryAt=this.now()+e.retryMs;throw e;}
    });
  }
  private async refreshProtocol(signal?:AbortSignal):Promise<void> {
    try {
      const updated=await this.api.protocol(signal);
      if(this.protocol&&(updated.block<this.protocol.block||updated.sourceAt<this.protocol.sourceAt))throw new Error('LP 数据链索引回退');
      if(this.now()-updated.sourceAt>this.config.lpMaxAgeMs||updated.sourceAt>this.now()+5000)throw new Error('LP 链索引时间异常');
      this.protocol=updated;this.protocolAt=this.now();this.protocolHealthy=true;
      this.store.set('protocolSnapshot',{protocol:updated,checkedAt:this.protocolAt});
      recordCurveMinute(this.store,updated);
      this.store.set('protocolHealth',{healthy:true,checkedAt:this.now()});this.rewards.wake();
    }catch(e){this.protocolHealthy=false;this.store.set('protocolHealth',{healthy:false,checkedAt:this.now(),reason:errorText(e)});throw e;}
  }
  private startLpPolling():void {
    this.lpLoopRunning=true;
    this.lpLoop=(async()=>{
      while(!this.lpAbort.signal.aborted) {
        const started=this.now();let backoff=0;
        try {await this.refreshProtocol(this.lpAbort.signal);}
        catch(e) {
          if(!this.lpAbort.signal.aborted)this.wait(`LP 读取暂停：${errorText(e)}`);
          if(e instanceof ApiError)backoff=e.retryMs;
        }
        if(this.lpAbort.signal.aborted)break;
        try {await delay(Math.max(backoff,this.config.lpPollIntervalMs-(this.now()-started),0),this.lpAbort.signal);}catch{}
      }
    })().finally(()=>{this.lpLoopRunning=false;});
  }
  private wallets():[Wallet,Wallet]|null {
    const [a,b]=this.identities.map(i=>this.sources.get(i.address)?.latest);
    return a&&b?[a,b]:null;
  }
  private tradingWallets(wallets:[Wallet,Wallet]):[Wallet,Wallet] {
    if(!this.config.reserveClaimedRewards)return wallets;
    return wallets.map(w=>({...w,available:max(0n,w.available-(this.store.get<{reserved:bigint}>(`rewardReserve:${w.address}`)?.reserved??0n))})) as [Wallet,Wallet];
  }
  private walletCurrent(address:Address):boolean {
    const source=this.sources.get(address);
    if(!source?.current||!source.latest)return false;
    // A live SSE socket is not proof that its account index has caught up.
    return !this.tradingHealthy||!this.trading||source.latest.block+30>=this.trading.block;
  }
  private current():boolean {return this.identities.every(i=>this.walletCurrent(i.address));}
  private dataHealth(q:Quote|null) {
    const now=this.now(),quoteAgeMs=q?now-q.time:null,quoteReceiveAgeMs=q?now-q.receivedAt:null,tradingAgeMs=this.tradingAt?now-this.tradingAt:null;
    const wallets=this.identities.map(i=>({wallet:i.address,current:this.walletCurrent(i.address),indexedBlock:this.sources.get(i.address)?.latest?.block??null}));
    const degraded=!q||quoteAgeMs===null||quoteAgeMs>this.config.quoteMaxAgeMs||quoteReceiveAgeMs===null||quoteReceiveAgeMs>this.config.quoteMaxAgeMs||
      !this.market||!this.tradingHealthy||tradingAgeMs===null||tradingAgeMs>5000||wallets.some(w=>!w.current);
    return {degraded,quoteAgeMs,quoteReceiveAgeMs,quoteSocket:this.quotes?.diagnostics?.()??null,tradingAgeMs,tradingHealthy:this.tradingHealthy,tradingError:this.lastTradingError,
      marketPresent:!!this.market,wallets};
  }
  private cachedSession(wallet:Address,kind:'active'|'candidate'):Session|null {
    const encrypted=this.store.get<string>(`session:${kind}:${wallet}`);
    return encrypted?decryptSession(encrypted,this.identities.find(i=>i.address===wallet)!):null;
  }
  private usableSession(w:Wallet,headroomSeconds=3660):Session|null {
    for(const kind of ['active','candidate'] as const) {
      const s=this.cachedSession(w.address,kind);if(!s)continue;
      const expiry=w.sessions[s.address];
      if(expiry && min(expiry,BigInt(s.expiry))>BigInt(Math.floor(this.now()/1000)+headroomSeconds))return s;
    }
    return null;
  }
  private async submit(i:Intent):Promise<void> {
    // UNKNOWN is committed before any I/O: a crash cannot turn a sent request into "unsent".
    this.store.updateIntent(i.id,'unknown');
    try {
      const receipt=await this.api.submit(i);
      const current=this.store.intent(i.id);
      if(!terminal(current))this.store.updateIntent(i.id,['failed','reverted'].includes(receipt.state)?'failed':receipt.state==='expired'?'expired':receipt.state==='cancelled'?'cancelled':'queued',receipt.queueRevision);
      log('intent_acknowledged',{wallet:i.wallet,action:i.action,state:receipt.state});
    } catch(e) {
      this.store.set(`intentLastError:${i.id}`,{wallet:i.wallet,action:i.action,at:this.now(),error:errorText(e),...(e instanceof ApiError?{status:e.status,code:e.code,definitive:e.definitive,reason:e.reason,retryMs:e.retryMs}:{})});
      // A concurrent SSE confirmation wins over an HTTP error or a late acknowledgement.
      if(!terminal(this.store.intent(i.id)) && e instanceof ApiError&&e.definitive) {
        this.store.updateIntent(i.id,'failed');
        if(i.action==='openPosition'&&['intake_action_paused','rate_limited'].includes(e.code)) {
          // Only an explicit rejection proves no fill. A timeout/unknown receipt is never retried here.
          this.store.set(`admissionRetry:${i.id}`,true);
          this.store.set('nextOpenAttemptAt',Math.max(this.store.get<number>('nextOpenAttemptAt')??0,this.now()+Math.max(this.config.pollIntervalMs,e.retryMs)));
        }
        if(i.action==='closePositions')this.closeBackoff.set(i.wallet,Math.max(this.closeBackoff.get(i.wallet)??0,this.now()+e.retryMs));
      }
      log('intent_response',{wallet:i.wallet,action:i.action,confirmation:terminal(this.store.intent(i.id))?'terminal':'unknown',error:errorText(e)});
    }
  }
  private reconcile(w:Wallet):void {
    if(!this.walletCurrent(w.address))return;
    for(const i of this.store.intents().filter(i=>i.wallet===w.address&&!terminal(i))) {
      const op=w.operations.some(o=>o.id===i.id);
      if(i.action==='registerSessionKey'&&typeof i.signed.key==='string') {
        const expiry=w.sessions[i.signed.key];if(expiry && expiry>=BigInt(String(i.signed.expiry))) {this.store.updateIntent(i.id,'succeeded');continue;}
      }
      if(i.action==='openPosition') {
        if(w.positions.some(p=>p.intentId===i.id)){this.store.updateIntent(i.id,'succeeded');continue;}
        const r=this.store.rounds().find(r=>r.id===i.round),leg=r?.legs.find(l=>l.openIntent===i.id);
        if(leg?.settled){this.store.updateIntent(i.id,'succeeded');continue;}
      }
      if(i.action==='closePositions') {
        const ids=i.signed.positionIds as string[];
        if(ids.every(id=>this.store.settlement(w.address,id)) && ids.every(id=>!w.positions.some(p=>p.id===id))) {this.store.updateIntent(i.id,'succeeded');continue;}
      }
      if(isReward(i)&&i.ackRevision!==null&&!op&&w.queueRevision>=BigInt(i.ackRevision)) {
        const before=this.store.get<{staked:bigint;claimed:bigint;quantity:bigint}>(`rewardBefore:${i.id}`);
        // Confirm from the acknowledged queue revision plus authoritative contract-account effect.
        if(before&&(i.action==='paperStake'?w.staked>=before.staked+before.quantity:w.claimedRewards>=before.claimed+before.quantity)) {
          this.store.updateIntent(i.id,'succeeded');this.store.set(`rewardConfirmedAt:${i.id}`,this.now());
          if(i.action==='paperClaim')this.store.set(`pendingReward:${w.address}`,{amount:0n,checkedAt:this.now()});
          continue;
        }
      }
      // Absence alone is not proof of rejection. Wait until the chain index has passed the signed deadline.
      const openEvidence=i.action==='openPosition'?this.store.get<{used:boolean;indexedTimestamp:number}>(`nonceEvidence:${i.id}`):null;
      const openExpiryProven=!!openEvidence&&!openEvidence.used&&openEvidence.indexedTimestamp>i.deadline;
      if(i.state!=='prepared'&&!op&&(w.timestamp>i.deadline||openExpiryProven)) {
        if(i.action==='openPosition'&&this.config.openTimeoutMs===null) {
          // For automatic renewal, absence of a position alone is not proof that an unseen open never executed.
          if(!openExpiryProven)continue;
        }
        if(i.action==='closePositions') {
          // A still-open position proves the expired close did not complete; otherwise require its settlement.
          if(!(i.signed.positionIds as string[]).some(id=>w.positions.some(p=>p.id===id)))continue;
        }
        this.store.updateIntent(i.id,'expired');
      }
    }
  }
  private checkNonceEvidence(w:Wallet):void {
    if(!this.api.nonceUsed||!this.walletCurrent(w.address))return;
    const activeRoundId=this.store.activeRound()?.id??null;
    for(const i of this.store.intents().filter(i=>i.wallet===w.address&&(!terminal(i)||i.action==='openPosition'&&i.state==='expired'&&i.round===activeRoundId&&this.config.openTimeoutMs===null)&&i.state!=='prepared')) {
      if(i.state==='expired') {
        const previous=this.store.get<{used:boolean;indexedTimestamp:number}>(`nonceEvidence:${i.id}`);
        // A spent nonce cannot become unused; an unused nonce observed after the signature
        // deadline cannot execute later. Neither finding needs another read.
        if(previous&&(previous.used||previous.indexedTimestamp>i.deadline))continue;
      }
      if(this.now()<(this.nonceReadAt.get(i.id)??0)||w.operations.some(o=>o.id===i.id))continue;
      this.nonceReadAt.set(i.id,this.now()+5000);
      this.background(`nonce:${i.id}`,async()=>{
        // An unchanged account need not emit a new wallet frame each block. Use the healthy protocol
        // index for negative open-expiry evidence, while reward-effect reconciliation stays wallet anchored.
        const protocol=i.action==='openPosition'&&this.protocolHealthy&&this.protocol&&this.protocol.block>=w.block?this.protocol:null;
        const block=protocol?.block??w.block,indexedTimestamp=protocol?Math.floor(protocol.sourceAt/1000):w.timestamp;
        let used:boolean;
        try{used=await this.api.nonceUsed!(i,block);}catch(e){log('nonce_evidence_unavailable',{wallet:w.address,action:i.action,round:i.round,block,error:errorText(e)});return;}
        const latest=this.sources.get(w.address);
        const stored=this.store.intent(i.id);
        if(!this.walletCurrent(w.address)||!latest?.latest||latest.latest.block<w.block||!stored||terminal(stored)&&!(stored.action==='openPosition'&&stored.state==='expired'))return;
        this.store.set(`nonceEvidence:${i.id}`,{used,block,indexedTimestamp,checkedAt:this.now()});
        // A spent nonce alone does not establish which operation succeeded. Require its exact effect too.
        if(used&&isReward(i)) {
          const before=this.store.get<{staked:bigint;claimed:bigint;quantity:bigint}>(`rewardBefore:${i.id}`),current=latest.latest;
          const effect=before&&(i.action==='paperStake'?current.staked>=before.staked+before.quantity:current.claimedRewards>=before.claimed+before.quantity);
          if(effect&&!current.operations.some(o=>o.id===i.id)) {
            this.store.updateIntent(i.id,'succeeded');this.store.set(`rewardConfirmedAt:${i.id}`,this.now());
            if(i.action==='paperClaim')this.store.set(`pendingReward:${w.address}`,{amount:0n,checkedAt:this.now()});
            log('intent_reconciled',{wallet:w.address,action:i.action,source:'indexed_nonce_and_account_effect'});this.rewards.wake();
          }
        }
      });
    }
  }
  private async ensureSession(identity:Identity,w:Wallet):Promise<boolean> {
    if(!this.walletCurrent(w.address))return false;
    const candidate=this.cachedSession(w.address,'candidate');
    if(candidate&&w.sessions[candidate.address] && w.sessions[candidate.address]!>=BigInt(candidate.expiry)) {
      this.store.set(`session:active:${w.address}`,encryptSession(candidate,identity));this.store.set(`session:candidate:${w.address}`,null);
    }
    if(this.usableSession(w))return true;
    if(this.trading?.disabledActions.includes('registerSessionKey')||this.now()<(this.sessionBackoff.get(w.address)??0))return false;
    const pending=this.store.intents().find(i=>i.wallet===w.address&&i.action==='registerSessionKey'&&!terminal(i));
    if(pending) {if(pending.state==='prepared')await this.submit(pending);return false;}
    let s=this.cachedSession(w.address,'candidate');
    if(!s || s.expiry<=Math.floor(this.now()/1000)+3660) {s=newSession(this.now());this.store.set(`session:candidate:${w.address}`,encryptSession(s,identity));}
    const nonce=this.store.nonce(w.address),deadline=Math.floor(this.now()/1000)+this.config.intentTtlSeconds;
    const signed=await signIntent(identity.master,'RegisterSessionKey',{user:w.address,key:s.address,expiry:BigInt(s.expiry),feeAddress:ZERO,nonce,deadline:BigInt(deadline)});
    const i:Intent={id:signed.id,wallet:w.address,round:null,action:'registerSessionKey',signed:signed.signed,state:'prepared',deadline,createdAt:this.now(),ackRevision:null};
    this.store.prepare(i);this.sessionBackoff.set(w.address,this.now()+30000);await this.submit(i);return false;
  }
  private owned(w:Wallet):Set<string> {
    return new Set(this.store.rounds().flatMap(r=>r.legs.filter(l=>l.wallet===w.address&&l.position).map(l=>l.position!.id)));
  }
  private async syncHistory(round:Round,wallets:[Wallet,Wallet]):Promise<void> {
    if(this.now()-this.historyAt<5000)return;
    const missing=round.legs.filter(l=>!l.settled&&(l.position?!wallets.find(w=>w.address===l.wallet)!.positions.some(p=>p.id===l.position!.id):this.store.intent(l.openIntent)?.state==='succeeded'||this.unaccounted(wallets)||this.store.get<{used:boolean}>(`nonceEvidence:${l.openIntent}`)?.used===true));
    if(!missing.length)return;
    this.historyAt=this.now();
    for(const leg of missing) {
      try {
        const history=await this.api.history(leg.wallet,round.createdAt-60000);
        const p=history.find(p=>leg.position?p.id===leg.position.id:p.openIntentId===leg.openIntent);
        if(!p) {
          if(!leg.position&&history.length&&this.unaccounted(wallets)) {
            this.store.set('unresolvedOwnership',{wallet:leg.wallet,round:round.id,openIntent:leg.openIntent,checkedAt:this.now(),reason:'历史接口未提供可核验的 openIntentId；不按时间、方向或金额猜测仓位归属'});
            this.recover('缺少开仓回执与仓位 ID 关联，需核实历史归属；已暂停新交易');
            this.wait('历史仓位归属无法核实，请查看 status 的 unresolvedOwnership');
          }
          continue;
        }
        const signed=this.store.intent(leg.openIntent)!.signed;
        if(p.instrumentId!==Number(signed.instrumentId)||p.isLong!==signed.isLong||p.margin!==BigInt(String(signed.size))||p.leverage!==Number(signed.leverage))throw new Error('Historical position identity mismatch');
        this.store.transaction(()=>{
          this.store.record(leg.wallet,round.id,p);
          const r=this.store.activeRound();if(!r||r.id!==round.id)return;
          const l=r.legs.find(l=>l.wallet===leg.wallet)!;l.settled=p;
          this.store.updateIntent(l.openIntent,'succeeded');
          if(this.store.get<{openIntent:Hex}>('unresolvedOwnership')?.openIntent===l.openIntent)this.store.set('unresolvedOwnership',null);
          if(l.closeIntent)this.store.updateIntent(l.closeIntent,'succeeded');this.store.saveRound(r);
        });
      } catch(e){log('history_reconciliation_pending',{wallet:leg.wallet,error:errorText(e)});}
    }
  }
  private unaccounted(wallets:[Wallet,Wallet]):boolean {
    const actual=wallets.reduce((sum,w)=>sum+w.realizedPnl-BigInt(this.store.get<string>(`baseline:${w.address}`)??String(w.realizedPnl)),0n);
    return actual!==this.store.totals().netPnl;
  }
  private async open(wallets:[Wallet,Wallet],m:Market,decision:StrategyDecision):Promise<void> {
    const chosen=effectiveConfig(this.config,decision);
    const id=this.store.nextRoundId(),margin=amount(chosen.marginUsdc),deadline=Math.floor(this.now()/1000)+this.config.openIntentTtlSeconds;
    const reverse=this.config.alternateDirections&&(this.store.totals().rounds%2===1);
    const intents=await Promise.all(wallets.map(async(w,index)=>{
      const session=this.usableSession(w);if(!session)throw new Error('Trading session not ready');
      const s=await signIntent(privateKeyToAccount(session.privateKey),'OpenPosition',{user:w.address,instrumentId:m.id,isLong:reverse?index!==0:index===0,size:margin,leverage:chosen.leverage,useDebt:false,nonce:this.store.nonce(w.address),deadline:BigInt(deadline)});
      return {id:s.id,wallet:w.address,round:id,action:'openPosition',signed:s.signed,state:'prepared',deadline,createdAt:this.now(),ackRevision:null} as Intent;
    }));
    // Re-check fresh balances/quotes after signing and before durable dispatch.
    const latest=this.wallets(),q=this.quotes?.latest;
    if(!this.protocolHealthy||!this.tradingHealthy)return;
    const schedule=openingSchedule(this.config.openingAtUtc,this.config.openingCheckLeadMs,this.now());
    if(!schedule.canOpen || schedule.openingAt!==null&&this.tradingReadStartedAt<schedule.openingAt || this.now()<(this.store.get<number>('nextOpenAttemptAt')??0) || this.stopRequested || this.tradeStoppedReason || this.store.get<boolean>('stopRequested') || !latest || !this.current() || !q || this.now()-q.time>this.config.quoteMaxAgeMs || this.now()-this.tradingAt>5000 || checkOpen(chosen,this.trading!,m,this.tradingWallets(latest),q.mid).length)return;
    if(this.store.intents().some(i=>isReward(i)&&!terminal(i)))return;
    const rechecked=decideStrategy(this.config,this.trading!,m,this.protocol!,this.tradingWallets(latest),this.now(),this.volatility.estimate(this.now()),efficiencyContext(this.store,this.config,this.now()));
    if(!rechecked.canOpen||rechecked.marginUsdc!==decision.marginUsdc||rechecked.leverage!==decision.leverage||rechecked.notionalUsdc!==decision.notionalUsdc||rechecked.closeMoveBps!==decision.closeMoveBps||rechecked.phase!==decision.phase) {
      log('open_recheck_changed',{plannedBps:decision.closeMoveBps,recheckedBps:rechecked.closeMoveBps,
        plannedLeverage:decision.leverage,recheckedLeverage:rechecked.leverage,plannedMarginUsdc:decision.marginUsdc,recheckedMarginUsdc:rechecked.marginUsdc,
        plannedVolatilitySamples:decision.volatilitySamples??null,recheckedVolatilitySamples:rechecked.volatilitySamples??null,reasons:rechecked.reasons});
      return;
    }
    const leadOpenIndex=chooseLeadOpenLeg(this.trading!,m,q.mid,margin*BigInt(chosen.leverage),[intents[0]!.signed.isLong===true,intents[1]!.signed.isLong===true]);
    const round:Round={id,state:'opening',createdAt:this.now(),reason:null,strategy:decision,leadOpenIndex,legs:intents.map(i=>({wallet:i.wallet,openIntent:i.id,position:null,closeIntent:null,settled:null})) as Round['legs']};
    this.store.transaction(()=>{this.store.saveRound(round);for(const i of intents)this.store.prepare(i);});
    this.oiGate.reset();
    log('round_opening',{round:id,marginUsdc:chosen.marginUsdc,leverage:chosen.leverage,phase:decision.phase,closeMoveBps:decision.closeMoveBps,reverse,leadOpenWallet:intents[leadOpenIndex]!.wallet,
      costPerPaperUsdc:decision.costPerPaperUsdc,estimatedHoldMinutes:decision.estimatedHoldMinutes,volatilityBpsPerSqrtMinute:decision.volatilityBpsPerSqrtMinute});
    this.notifier.queue('open_submitted',id);
    if(amount(this.config.oiHeadroomUsdc)===0n){for(const i of intents)this.dispatch(i);return;}
    const lead=intents[leadOpenIndex]!,sibling=intents[1-leadOpenIndex]!;
    await this.submit(lead);
    const state=this.store.intent(lead.id)?.state;
    if((state==='queued'||state==='succeeded')&&!this.stopRequested&&!this.tradeStoppedReason) {this.dispatch(sibling);return;}
    const error=this.store.get<{status?:number;code?:string;definitive?:boolean;reason?:string;retryMs?:number}>(`intentLastError:${lead.id}`);
    const observedLead=this.wallets()?.find(w=>w.address===lead.wallet);
    const leadEffect=observedLead?.positions.some(p=>p.intentId===lead.id)||observedLead?.operations.some(o=>o.id===lead.id);
    const oiRejected=error?.code==='admission_rejected'&&error.reason==='openInterest';
    const temporaryRejected=error?.code==='rate_limited'||error?.code==='intake_action_paused';
    if(state==='failed'&&error?.definitive&&!leadEffect&&(oiRejected||temporaryRejected)) {
      const nextAttemptAt=Math.max(this.store.get<number>('nextOpenAttemptAt')??0,this.now()+(oiRejected?this.config.oiAdmissionCooldownMs:Math.max(this.config.pollIntervalMs,error.retryMs??0)));
      this.store.transaction(()=>{
        this.store.updateIntent(sibling.id,'cancelled');
        const current=this.store.activeRound();if(!current||current.id!==id)return;
        current.state='complete';current.reason=oiRejected?'先导开仓因 OI 被明确拒绝，未提交对冲侧；冷却后重新检查':'先导开仓被明确暂时拒绝，未提交对冲侧；退避后重新检查';this.store.saveRound(current);
        this.store.set('nextOpenAttemptAt',nextAttemptAt);
      });
      log('opening_retry_wait',{round:id,leadWallet:lead.wallet,reason:oiRejected?'官方 OI 拒绝先导侧，未提交另一侧':'官方暂时拒绝先导侧，未提交另一侧',nextAttemptAt});
      return;
    }
    this.recover('先导开仓未确认或被拒绝，未提交对冲侧；退出已成交仓位');
  }
  private async cancelOpen(i:Intent,w:Wallet):Promise<void> {
    if(i.action!=='openPosition')throw new Error('自动取消仅适用于未完成的开仓请求');
    if(terminal(i))return;
    if(i.state==='prepared') {this.store.updateIntent(i.id,'cancelled');return;}
    if(this.now()<(this.cancelBackoff.get(i.id)??0))return;
    const session=this.usableSession(w,5);if(!session)return;
    this.cancelBackoff.set(i.id,this.now()+15000);
    try {
      const deadline=Number(min(BigInt(Math.floor(this.now()/1000)+3600),min(BigInt(session.expiry),w.sessions[session.address]!)-5n));
      const signed=await signIntent(privateKeyToAccount(session.privateKey),'CancelIntent',{user:w.address,intentId:i.id,deadline:BigInt(deadline)});
      const result=await this.api.cancel(i.id,signed.signed);
      if(result==='cancelled'&&!terminal(this.store.intent(i.id)))this.store.updateIntent(i.id,'cancelled');
    } catch(e){log('cancel_pending',{wallet:w.address,error:errorText(e)});}
  }
  private async closeLeg(round:Round,index:number,w:Wallet):Promise<void> {
    const leg=round.legs[index]!;if(!leg.position||leg.settled)return;
    if(!this.walletCurrent(w.address)){this.wait('账户索引过期，等待新快照后退出存量仓位');return;}
    if(!w.positions.some(p=>p.id===leg.position!.id))return; // Await a fresh authoritative settlement, not a second close.
    if(leg.closeIntent&&!terminal(this.store.intent(leg.closeIntent))) {
      const pending=this.store.intent(leg.closeIntent)!;
      if(pending.state==='prepared')this.dispatch(pending);
      // Closing has no local wait deadline and never calls the cancellation endpoint.
      // Reconciliation must first establish a terminal outcome before a replacement can be signed.
      if(this.now()-(this.closeWaitAt.get(w.address)??0)>=5000) {
        this.closeWaitAt.set(w.address,this.now());
        log('closing_wait',{round:round.id,wallet:w.address,positionId:leg.position.id,state:pending.state,elapsedSeconds:Math.floor((this.now()-pending.createdAt)/1000),autoCancel:false});
      }
      return;
    }
    if(this.now()<(this.closeBackoff.get(w.address)??0))return;
    const session=this.usableSession(w,5);if(!session) {this.wait('存量退出等待有效 session 授权');return;}
    if(this.trading?.disabledActions.includes('closePositions')) {this.wait('官方暂停平仓，保留恢复状态');return;}
    const deadline=Number(min(BigInt(Math.floor(this.now()/1000)+this.config.intentTtlSeconds),min(BigInt(session.expiry),w.sessions[session.address]!)-5n));
    const signed=await signIntent(privateKeyToAccount(session.privateKey),'Close',{user:w.address,positionIds:[BigInt(leg.position.id)],nonce:this.store.nonce(w.address),deadline:BigInt(deadline)});
    const i:Intent={id:signed.id,wallet:w.address,round:round.id,action:'closePositions',signed:signed.signed,state:'prepared',deadline,createdAt:this.now(),ackRevision:null};
    const current=this.store.activeRound();if(!current||current.id!==round.id||current.legs[index]!.settled)return;
    current.legs[index]!.closeIntent=i.id;
    this.store.transaction(()=>{this.store.prepare(i);this.store.saveRound(current);});
    this.notifier.queue('close_submitted',round.id);
    this.closeBackoff.set(w.address,this.now()+15000);
    this.dispatch(i);
  }
  private renewUnfilledRound(round:Round,wallets:[Wallet,Wallet]):boolean {
    if(this.config.openTimeoutMs!==null||this.stopRequested||this.tradeStoppedReason||!this.current()||round.legs.some(l=>l.position||l.settled))return false;
    const intents=round.legs.map(l=>this.store.intent(l.openIntent)!);
    const temporary=(i:Intent)=>i.state==='failed'&&this.store.get<boolean>(`admissionRetry:${i.id}`)===true;
    const retryableEnd=(i:Intent)=>i.state==='cancelled'||i.state==='expired'||temporary(i);
    if(intents.some(i=>terminal(i)&&!retryableEnd(i)))return false;
    const indexedPastDeadline=(i:Intent)=>Math.max(wallets.find(w=>w.address===i.wallet)!.timestamp,this.protocolHealthy&&this.protocol?Math.floor(this.protocol.sourceAt/1000):0)>i.deadline;
    if(!intents.some(i=>retryableEnd(i)||indexedPastDeadline(i)))return false;
    if(intents.some(i=>this.store.get<{used:boolean}>(`nonceEvidence:${i.id}`)?.used)) {
      const used=intents.find(i=>this.store.get<{used:boolean}>(`nonceEvidence:${i.id}`)?.used)!;
      this.store.set('unresolvedOwnership',{wallet:used.wallet,round:round.id,openIntent:used.id,checkedAt:this.now(),reason:'开仓 nonce 已使用，但没有可核验的仓位 ID；不能认定为未成交并重试'});
      this.recover('开仓 nonce 已使用但尚未取得仓位归属，等待权威对账');return true;
    }
    // If one sibling ends, cancel the other before a possible late fill. Never submit a replacement hedge.
    for(const i of intents)if(!terminal(i)&&!this.jobs.has(`submit:${i.id}`)) {
      const w=wallets.find(w=>w.address===i.wallet)!;
      this.background(`cancel:${i.id}`,()=>this.cancelOpen(i,w));
    }
    const expiredProven=(i:Intent)=>{
      if(i.state!=='expired')return true;
      const e=this.store.get<{used:boolean;block:number;indexedTimestamp:number}>(`nonceEvidence:${i.id}`);
      return !!e&&!e.used&&e.indexedTimestamp>i.deadline;
    };
    if(intents.every(i=>retryableEnd(i)&&expiredProven(i)&&!this.jobs.has(`submit:${i.id}`)&&!this.jobs.has(`cancel:${i.id}`))&&wallets.every(w=>!w.positions.length&&!w.operations.some(o=>intents.some(i=>i.id===o.id)))&&!this.unaccounted(wallets)) {
      round.state='complete';round.reason='两边均未成交，旧请求已取消或确认过期；重新检查后重试';this.store.saveRound(round);
      this.store.set('nextOpenAttemptAt',Math.max(this.store.get<number>('nextOpenAttemptAt')??0,this.now()+this.config.pollIntervalMs));
      log('opening_retry_wait',{round:round.id,reason:round.reason,nextAttemptAt:this.store.get<number>('nextOpenAttemptAt')});
    } else this.wait('等待旧开仓请求取消／过期及未成交证据，不重复下单');
    return true;
  }
  private async exitRound(round:Round,wallets:[Wallet,Wallet]):Promise<void> {
    await Promise.all(round.legs.map(async(leg,index)=>{
      const w=wallets.find(w=>w.address===leg.wallet)!;
      const i=this.store.intent(leg.openIntent);
      // Cancel an unknown/pending sibling before a possible late fill; continue flattening any confirmed own position.
      if(i&&!terminal(i))this.background(`cancel:${i.id}`,()=>this.cancelOpen(i,w));
      const current=this.store.activeRound();if(current)await this.closeLeg(current,index,w);
    }));
    const current=this.store.activeRound();if(!current)return;
    const fresh=this.wallets();if(!fresh || !this.current())return;
    const done=current.legs.every(leg=>{
      const w=fresh.find(w=>w.address===leg.wallet)!,open=this.store.intent(leg.openIntent);
      if(!terminal(open)||w.operations.some(o=>o.id===leg.openIntent||o.id===leg.closeIntent))return false;
      if(leg.settled)return !w.positions.some(p=>p.id===leg.settled!.id);
      if(leg.position)return false;
      if(this.store.get<{used:boolean}>(`nonceEvidence:${leg.openIntent}`)?.used)return false;
      return open?.state!=='succeeded';
    });
    if(done) {
      if(this.unaccounted(fresh)){this.wait('账户已实现盈亏尚未与脚本结算匹配，禁止开始下一轮');return;}
      const emptyDataInterrupted=current.reason==='行情或账户状态中断'&&current.legs.every(l=>!l.position&&!l.settled);
      current.state='complete';this.store.saveRound(current);
      recordExecutionTiming(this.store,current);
      log('round_complete',{round:current.id,reason:current.reason,filledLegs:current.legs.filter(l=>l.position||l.settled).length,settledLegs:current.legs.filter(l=>l.settled).length,openStates:current.legs.map(l=>this.store.intent(l.openIntent)?.state),netPnlUsdc:usd(current.legs.reduce((n,l)=>n+(l.settled?.netPnl??0n),0n)),paper:usd(current.legs.reduce((n,l)=>n+(l.settled?.paper??0n),0n))});
      if(current.legs.some(l=>l.settled))this.notifier.queue('round_settled',current.id);
      if(emptyDataInterrupted&&!this.stopRequested&&!this.store.get<boolean>('stopRequested')) {
        // Both signed opens are terminal, no position was ever observed, and
        // the live accounts are flat. A transient data gap must not permanently
        // disable trading after that authoritative empty reconciliation.
        this.tradeStoppedReason=null;this.failureReason=null;this.store.set('tradeStoppedReason',null);
        const nextAttemptAt=this.now()+Math.max(30000,this.config.pollIntervalMs);
        this.store.set('nextOpenAttemptAt',Math.max(nextAttemptAt,this.store.get<number>('nextOpenAttemptAt')??0));
        log('opening_data_retry',{round:current.id,nextAttemptAt:this.store.get<number>('nextOpenAttemptAt')});
      }
    }
  }
  async tick():Promise<'continue'|'stop'> {
    try{return await this.tickOnce();}finally{this.saveRuntimeCheckpoint();}
  }
  private async tickOnce():Promise<'continue'|'stop'> {
    this.notifier.pump();
    const now=this.now();
    if(this.store.get<boolean>('stopRequested'))this.stopRequested=true;
    const schedule=openingSchedule(this.config.openingAtUtc,this.config.openingCheckLeadMs,now);
    // Recovery is never delayed by a new launch schedule. Existing positions must remain manageable.
    if(!this.rewardsOnly&&!this.store.activeRound()&&!schedule.canCheck&&!this.stopRequested) {
      this.wait(`定时等待；${new Date(schedule.checkAt!).toISOString()} 开始检查官方状态`);return 'continue';
    }
    this.refreshTrading();
    await Promise.resolve(); // Let already-resolved cache reads finish; never await a network request here.
    try {
      if(!this.lpLoopRunning&&(!this.protocol||this.now()-this.lastLpAttemptAt>=this.config.lpPollIntervalMs)) {
        this.lastLpAttemptAt=this.now();
        if(this.store.activeRound())this.background('protocol',()=>this.refreshProtocol());else await this.refreshProtocol();
      }
    } catch(e){this.wait(`只读接口不可用：${errorText(e)}`);}
    const wallets=this.wallets();
    const sample=this.quotes?.latest;
    if(sample&&now-sample.time<=this.config.quoteMaxAgeMs&&now-sample.receivedAt<=this.config.quoteMaxAgeMs&&
      this.volatility.observe(sample.mid,sample.time))this.store.set('priceMinutes',this.volatility.export());
    if(!wallets) {this.rewards.wake();this.wait('等待两个账户完整快照');return this.stopRequested&&!this.store.activeRound()?'stop':'continue';}
    for(const w of wallets) { // Also supports test sources; live sources have already persisted each frame.
      if(this.store.get<string>(`baseline:${w.address}`)===null)this.observe(w);
      this.reconcile(w);
      this.checkNonceEvidence(w);
    }
    let r=this.store.activeRound();
    const foreign=wallets.some(w=>w.positions.some(p=>{
      if(this.owned(w).has(p.id))return false;
      const i=p.intentId?this.store.intent(p.intentId):null;
      return !i||i.wallet!==w.address||i.action!=='openPosition'||i.round===null;
    }));
    if(foreign){if(r)this.recover('发现非脚本持仓，停止新交易');else{this.requestStop('存在人工持仓');this.failureReason='存在人工持仓';}}
    if(r)this.background('history',()=>this.syncHistory(r!,wallets));
    r=this.store.activeRound();
    this.rewards.wake();
    if(this.current()&&(!this.stopRequested&&!this.tradeStoppedReason||r)) {
      if(r)for(const [index,i] of this.identities.entries())this.background(`session:${i.address}`,async()=>{await this.ensureSession(i,wallets[index]!);});
      else await Promise.all(this.identities.map((i,index)=>this.ensureSession(i,wallets[index]!)));
    }
    await Promise.resolve();
    r=this.store.activeRound();
    if(r) {
      const q=this.quotes?.latest??null;
      if(r.legs.some(l=>l.settled?.liquidated))this.recover('单边强平');
      if(r.legs.some(l=>l.position&&!l.settled&&!this.usableSession(wallets.find(w=>w.address===l.wallet)!,300)))this.recover('Session 续期未确认，旧授权即将到期，退出存量仓位');
      if(this.current()&&(r.state==='hedged'||r.state==='opening')&&r.legs.some(l=>l.position&&(l.settled||!wallets.find(w=>w.address===l.wallet)!.positions.some(p=>p.id===l.position!.id))))this.recover('对冲侧仓位提前消失，等待对账并退出另一侧');
      if((this.stopRequested||this.tradeStoppedReason) && r.state!=='recovering'&&r.state!=='closing')this.recover('停止请求：退出存量仓位');
      r=this.store.activeRound()!;
      const health=this.dataHealth(q),dataDegraded=health.degraded;
      if(r.state==='hedged') {
        if(dataDegraded&&this.now()-this.startedAt>5000) {
          if(!this.hedgedDataGap||this.hedgedDataGap.roundId!==r.id) {
            this.hedgedDataGap={roundId:r.id,startedAt:this.now()};
            this.store.set('activeDataGap',this.hedgedDataGap);
            log('hedged_data_degraded',{round:r.id,graceMs:this.config.hedgedDataGraceMs,...health});
          }
          const elapsedMs=this.now()-this.hedgedDataGap.startedAt;
          if(elapsedMs>=this.config.hedgedDataGraceMs) {
            const evidence={round:r.id,at:this.now(),startedAt:this.hedgedDataGap.startedAt,elapsedMs,...health};
            this.store.set('lastDataFailure',evidence);
            this.store.set('activeDataGap',null);this.hedgedDataGap=null;
            log('hedged_data_timeout',evidence);
            this.recover('行情或账户状态中断');
          }
        } else if(!dataDegraded&&this.hedgedDataGap?.roundId===r.id) {
          const recovered={round:r.id,at:this.now(),startedAt:this.hedgedDataGap.startedAt,elapsedMs:this.now()-this.hedgedDataGap.startedAt,...health};
          this.store.set('lastDataGap',recovered);this.store.set('activeDataGap',null);this.hedgedDataGap=null;
          log('hedged_data_restored',recovered);
        }
      } else if(r.state==='opening'&&dataDegraded&&this.now()-this.startedAt>5000) {
        if(!this.openingDataGap||this.openingDataGap.roundId!==r.id) {
          this.openingDataGap={roundId:r.id,startedAt:this.now()};
          this.store.set('activeOpeningDataGap',this.openingDataGap);
          log('opening_data_degraded',{round:r.id,graceMs:this.config.hedgedDataGraceMs,...health});
        }
        const elapsedMs=this.now()-this.openingDataGap.startedAt;
        if(elapsedMs>=this.config.hedgedDataGraceMs) {
          const evidence={round:r.id,at:this.now(),startedAt:this.openingDataGap.startedAt,elapsedMs,...health};
          this.store.set('lastOpeningDataFailure',evidence);
          this.store.set('activeOpeningDataGap',null);this.openingDataGap=null;
          log('opening_data_timeout',evidence);
          this.recover('行情或账户状态中断');
        }
      } else if(r.state==='opening'&&!dataDegraded&&this.openingDataGap?.roundId===r.id) {
        log('opening_data_restored',{round:r.id,elapsedMs:this.now()-this.openingDataGap.startedAt,...health});
        this.store.set('activeOpeningDataGap',null);this.openingDataGap=null;
      }
      if(this.store.activeRound()?.state!=='hedged'&&this.hedgedDataGap?.roundId===r.id) {
        this.store.set('activeDataGap',null);this.hedgedDataGap=null;
      }
      if(this.store.activeRound()?.state!=='opening'&&this.openingDataGap?.roundId===r.id) {
        this.store.set('activeOpeningDataGap',null);this.openingDataGap=null;
      }
      r=this.store.activeRound()!;
      if(r.state==='opening') {
        const positions=r.legs.map(l=>l.position);
        const retryable=r.legs.every(l=>!l.position&&!l.settled&&this.store.intent(l.openIntent)?.state==='failed'&&this.store.get<boolean>(`admissionRetry:${l.openIntent}`)===true);
        if(retryable&&this.current()&&!this.unaccounted(wallets)&&r.legs.every(l=>!wallets.find(w=>w.address===l.wallet)!.operations.some(o=>o.id===l.openIntent))) {
          r.state='complete';r.reason='开仓被明确暂时拒绝，未形成持仓；退避后重新检查';this.store.saveRound(r);
          log('opening_retry_wait',{round:r.id,nextAttemptAt:this.store.get<number>('nextOpenAttemptAt')});return 'continue';
        }
        if(this.renewUnfilledRound(r,wallets))return 'continue';
        if(r.legs.some(l=>{const i=this.store.intent(l.openIntent);return terminal(i)&&i?.state!=='succeeded';}))this.recover('开仓未形成完整对冲');
        else if(positions[0]&&positions[1]) {
          if(entryGapTooLarge([positions[0].entry,positions[1].entry],this.config.maxEntryGapBps))this.recover('两边开仓价偏差过大');
          else if(positions.some(p=>bustDistanceBps(p!)<BigInt((r!.strategy?.closeMoveBps??100)+entryGapBpsCeil([positions[0]!.entry,positions[1]!.entry])+this.config.bustHeadroomBps)))this.recover('实仓强平缓冲不足');
          else {r.state='hedged';this.store.saveRound(r);log('round_hedged',{round:r.id,baseCloseBps:r.strategy?.closeMoveBps??100,entryGapBpsCeil:entryGapBpsCeil([positions[0].entry,positions[1].entry]),effectiveCloseBpsCeil:(r.strategy?.closeMoveBps??100)+entryGapBpsCeil([positions[0].entry,positions[1].entry])});this.notifier.queue('open_hedged',r.id);}
        }
        else if(positions.some(p=>p)) {
          if(r.firstFillAt===undefined){r.firstFillAt=Math.max(r.createdAt,Math.min(this.now(),...positions.filter(p=>p!==null).map(p=>p.openedAtMs)));this.store.saveRound(r);}
          if(this.now()-r.firstFillAt>this.config.hedgeTimeoutMs)this.recover('单边开仓等待对冲超时，退出已成交仓位');
        }
        else if(this.config.openTimeoutMs!==null&&this.now()-r.createdAt>this.config.openTimeoutMs)this.recover('开仓未形成完整对冲');
        if(this.store.activeRound()?.state==='opening'&&this.now()-this.lastOpenWaitAt>=5000) {
          this.lastOpenWaitAt=this.now();
          log('opening_wait',{round:r.id,elapsedSeconds:Math.floor((this.now()-r.createdAt)/1000),filledLegs:positions.filter(Boolean).length,openStates:r.legs.map(l=>this.store.intent(l.openIntent)?.state),queueTimeoutMs:this.config.openTimeoutMs,hedgeTimeoutMs:this.config.hedgeTimeoutMs});
        }
      }
      r=this.store.activeRound()!;
      if(r.state==='hedged'&&!dataDegraded&&q&&this.market) {
        const [a,b]=r.legs.map(l=>l.position!) as [NonNullable<Round['legs'][0]['position']>,NonNullable<Round['legs'][0]['position']>];
        if(this.now()-q.time<=this.config.quoteMaxAgeMs&&this.now()-q.receivedAt<=this.config.quoteMaxAgeMs&&q.mid>0n) {
          this.quoteWindow.push({at:this.now(),mid:q.mid});
          this.quoteWindow=this.quoteWindow.filter(x=>x.at>=this.now()-60000);
        }
        const oldest=this.quoteWindow[0],latest=this.quoteWindow.at(-1);
        const mids=this.quoteWindow.map(x=>x.mid),lowest=mids.length?mids.reduce((a,b)=>a<b?a:b):0n,highest=mids.length?mids.reduce((a,b)=>a>b?a:b):0n;
        const observedRangeBps=oldest&&latest&&latest.at-oldest.at>=30000&&highest+lowest>0n?Number((highest-lowest)*20000n/(highest+lowest)):null;
        if(r.strategy&&this.config.strategyMode==='lpAccumulating'&&this.protocolHealthy&&this.tradingHealthy&&this.protocol&&this.trading&&this.now()-this.tradingAt<=5000&&this.current()&&this.now()-q.time<=this.config.quoteMaxAgeMs) {
          // A config reload may change the policy for *future* rounds. Keep the
          // horizon captured at this round's open; legacy rounds used 480 min.
          const roundHorizon=r.strategy.costModeMaxHoldMinutes===undefined?480:r.strategy.costModeMaxHoldMinutes;
          const roundObjective=r.strategy.costModeObjective??'unitCost';
          const liveConfig={...this.config,costModeMaxHoldMinutes:roundObjective==='throughput'?null:roundHorizon,costModeObjective:roundObjective};
          const live=decideLiveClose(liveConfig,this.trading,this.market,this.protocol,wallets,[a,b],this.now()-Math.max(a.openedAtMs,b.openedAtMs),this.now(),observedRangeBps,this.volatility.estimate(this.now()),q.mid,efficiencyContext(this.store,this.config,this.now()));
          this.store.set('liveCloseDecision',{at:this.now(),round:r.id,currentBps:r.strategy.closeMoveBps,candidateBps:live?.closeMoveBps??null,objective:roundObjective,closeEfficiency:live?.closeEfficiency??null});
          if(this.now()-this.lastCloseTargetReportAt>=60000) {
            this.lastCloseTargetReportAt=this.now();
            log('close_target_monitor',{round:r.id,currentBps:r.strategy.closeMoveBps,candidateBps:live?.closeMoveBps??null,
              plannedLossesPerWallet:live?.plannedLossesPerWallet??null,estimatedCostToStakeUsdc:live?.estimatedCostToStakeUsdc??null,
              observedRangeBps,slowClose:live?.slowClose??null,walletStakePlans:live?.walletStakePlans??null,
              volatilityBpsPerSqrtMinute:live?.volatilityBpsPerSqrtMinute??null,estimatedHoldMinutes:live?.estimatedHoldMinutes??null,closeEfficiency:live?.closeEfficiency??null,protocolBlock:this.protocol.block});
          }
          // In-position targets may only move closer; a restart or short volatility spike
          // must not undo a previously accepted faster exit.
          if(live&&live.closeMoveBps<r.strategy.closeMoveBps) {
            const fromBps=r.strategy.closeMoveBps;
            r.strategy={...r.strategy,mode:'lpAccumulating',closeMoveBps:live.closeMoveBps,plannedLossesPerWallet:live.plannedLossesPerWallet??undefined,
              conservativePaper:live.conservativePaper,projectedPaperAfterRounds:live.projectedPaperAfterRounds??undefined,stakeTargetPaper:live.stakeTargetPaper,
              walletStakePlans:live.walletStakePlans,
              costPerPaperUsdc:live.costPerPaperUsdc,estimatedHoldMinutes:live.estimatedHoldMinutes,
              volatilityBpsPerSqrtMinute:live.volatilityBpsPerSqrtMinute,volatilitySamples:live.volatilitySamples,horizonSatisfied:live.horizonSatisfied,closeEfficiency:live.closeEfficiency,
              expectedPaper:live.expectedPaper,expectedNetLossUsdc:live.expectedNetLossUsdc,sourceAt:live.sourceAt,sourceBlock:live.sourceBlock};
            this.store.saveRound(r);
            log('close_target_updated',{round:r.id,fromBps,toBps:live.closeMoveBps,plannedLossesPerWallet:live.plannedLossesPerWallet,
              projectedPaperAfterRounds:live.projectedPaperAfterRounds,stakeTargetPaper:live.stakeTargetPaper,slowClose:live.slowClose,
              observedRangeBps:live.observedRangeBps,estimatedCostToStakeUsdc:live.estimatedCostToStakeUsdc,walletStakePlans:live.walletStakePlans,protocolBlock:live.sourceBlock});
          }
        }
        const openPnl=r.legs.reduce((sum,l)=>sum+(l.settled?0n:netPnl(l.position!,q.mid,this.market!)),0n);
        const bps=r.strategy?.closeMoveBps??100;
        if(this.config.maxNetLossUsdc!==null&&max(0n,-this.store.totals().netPnl-openPnl)>=amount(this.config.maxNetLossUsdc))this.recover('持仓净损耗触及停止阈值');
        else if(this.market.retired||this.market.closeOnly||movedBeyondWithEntryGap(q.mid,[a.entry,b.entry],bps)) {r.state='closing';r.reason=this.market.retired?'市场退出':`${bps} bps 基础阈值 + 实际开仓价差平仓触发`;this.store.saveRound(r);}
      }
      r=this.store.activeRound()!;
      if(r.state==='closing'||r.state==='recovering')await this.exitRound(r,wallets);
      return this.stopRequested&&!this.store.activeRound()?'stop':'continue';
    }
    if(this.stopRequested)return 'stop';
    if(this.tradeStoppedReason){this.wait(`${this.tradeStoppedReason}；继续质押和分红监控`);return 'continue';}
    if(this.store.get('unresolvedOwnership')){this.wait('历史仓位归属尚未核实，禁止新开仓');return 'continue';}
    if(!schedule.canOpen){this.wait(`检查官方开放状态；最早 ${this.config.openingAtUtc} 允许新开仓`);return 'continue';}
    if(schedule.openingAt!==null&&this.tradingReadStartedAt<schedule.openingAt){this.wait('等待开放时间之后的新官方状态');return 'continue';}
    if(this.now()<(this.store.get<number>('nextOpenAttemptAt')??0)){this.wait('开仓明确暂时拒绝，遵守重试退避');return 'continue';}
    if(!this.protocolHealthy||!this.tradingHealthy){this.oiGate.reset();this.wait('LP 或交易状态不健康，等待新的有效快照');return 'continue';}
    if(!this.current()||!this.market||!this.trading||!this.protocol||this.now()-this.tradingAt>5000||this.now()-this.protocolAt>this.config.lpMaxAgeMs){this.oiGate.reset();this.wait('等待账户与协议同步');return 'continue';}
    if(this.unaccounted(wallets)){this.wait('账户盈亏变化未归属脚本，禁止新开仓');return 'continue';}
    const totals=this.store.totals(),remaining=this.config.maxNetLossUsdc===null?null:amount(this.config.maxNetLossUsdc)+totals.netPnl;
    if(remaining!==null&&remaining<=0n || this.config.maxRounds!==null&&totals.rounds>=this.config.maxRounds){this.haltTrading('损耗或轮数限制');return this.stopRequested?'stop':'continue';}
    const q=this.quotes?.latest;
    if(!q||this.now()-q.time>this.config.quoteMaxAgeMs||this.now()-q.receivedAt>this.config.quoteMaxAgeMs){this.oiGate.reset();this.wait('等待新鲜 BBO 报价');return 'continue';}
    const tradeWallets=this.tradingWallets(wallets);
    const decision=decideStrategy(this.config,this.trading,this.market,this.protocol,tradeWallets,this.now(),this.volatility.estimate(this.now()),efficiencyContext(this.store,this.config,this.now()));
    this.store.set('strategyDecision',decision);
    const chosen=effectiveConfig(this.config,decision);
    if(remaining!==null&&estimateRoundCost(this.market,amount(chosen.marginUsdc),chosen.leverage,chosen.closeMoveBps+this.config.maxEntryGapBps)>remaining){this.haltTrading('剩余损耗预算不足以覆盖预计下一轮');return this.stopRequested?'stop':'continue';}
    const reasons=[...decision.reasons,...checkOpen(chosen,this.trading,this.market,tradeWallets,q.mid)];
    this.notifier.queueMarginWarning(this.config,decision,this.market,tradeWallets,reasons);
    const admission=this.oiGate.observe(this.trading.block,reasons.length===0,this.now(),this.config.oiStableSnapshots,this.config.oiStableMinMs);
    this.store.set('oiAdmissionHealth',{at:this.now(),block:this.trading.block,...admission,reasons});
    if(reasons.length){this.wait(reasons.join('; '));return 'continue';}
    if(!admission.ready){this.wait(`等待 OI 安全余量连续快照 ${admission.count}/${admission.required}，已稳定 ${admission.stableMs} ms`);return 'continue';}
    if(this.config.autoStake&&wallets.some(w=>w.paper>0n&&w.paper>=this.trading!.minPaperStake)){this.wait('优先质押已到账 PAPER');return 'continue';}
    if(this.store.intents().some(i=>isReward(i)&&!terminal(i))){this.wait('等待质押或领取确认，不重复下单');return 'continue';}
    if(!wallets.every(w=>this.usableSession(w))){this.wait('等待 session 注册或续期确认');return 'continue';}
    this.lastWait='';await this.open(wallets,this.market,decision);return 'continue';
  }
  async run():Promise<void> {
    for(const source of this.sources.values())source.start();this.quotes?.start();this.startLpPolling();
    try {
      for(;;) {
        const started=this.now();
        try {if(await this.tick()==='stop')break;}catch(e){log('engine_recovery',{error:errorText(e)});if(this.store.activeRound())this.recover('运行错误，进入存量退出');else throw e;}
        await delay(Math.max(0,this.config.pollIntervalMs-(this.now()-started)));
      }
    } finally {
      for(const source of this.sources.values())source.stop();this.quotes?.stop();
      this.tradingAbort.abort();this.lpAbort.abort();await Promise.all([this.rewards.shutdown(),this.notifier.shutdown(),this.lpLoop,this.drainBackground()]);
      this.saveRuntimeCheckpoint('stopped');
    }
  }
}
