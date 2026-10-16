import type { Store } from './store.js';
import type { Address } from 'viem';
import { usd } from './util.js';
import { PriceVolatility, type MinutePrice } from './volatility.js';

const terminal=new Set(['succeeded','failed','expired','cancelled']);
const states=new Set(['prepared','unknown','queued',...terminal]);
const actions=new Set(['registerSessionKey','openPosition','closePositions','paperStake','paperClaim']);

/** Project durable state into a safe, consistent, read-only view. Never return signed payloads or keys. */
export function readCheckpoint(store:Store,now=Date.now()) {
  store.db.exec('BEGIN');
  try {
    const rounds=store.rounds(),intents=store.intents(),wallets=store.snapshots();
    const active=rounds.filter(r=>r.state!=='complete'),r=active[0]??null;
    const addresses=store.get<Address[]>('addresses')??[];
    const pending=intents.filter(i=>!terminal.has(i.state));
    const errors:string[]=[];
    if(active.length>1)errors.push('存在多个未完成轮次，禁止自动恢复');
    if((rounds.length||intents.length||wallets.length)&&(!store.get('identity')||addresses.length!==2))errors.push('状态库缺少完整的钱包身份绑定');
    for(const i of intents)if(!states.has(i.state)||!actions.has(i.action))errors.push(`请求 ${i.id} 的动作或状态无效`);
    for(const w of wallets)if(!addresses.includes(w.address))errors.push('账户快照与状态库钱包不匹配');
    if(r) {
      if(!['opening','hedged','closing','recovering'].includes(r.state)||r.legs.length!==2||new Set(r.legs.map(l=>l.wallet)).size!==2)errors.push('未完成轮次结构无效');
      for(const leg of r.legs) {
        if(!addresses.includes(leg.wallet))errors.push('轮次钱包与状态库身份不匹配');
        for(const [id,action] of [[leg.openIntent,'openPosition'],[leg.closeIntent,'closePositions']] as const) {
          if(!id)continue;
          const i=intents.find(i=>i.id===id);
          if(!i||i.wallet!==leg.wallet||i.round!==r.id||i.action!==action)errors.push(`轮次 ${r.id} 缺少匹配的 ${action} 请求`);
        }
      }
    }
    for(const i of pending) {
      if(!addresses.includes(i.wallet)||i.signed.user!==i.wallet)errors.push(`待确认请求 ${i.id} 的钱包身份不匹配`);
      if(i.action==='openPosition'||i.action==='closePositions') {
        const owner=active.find(r=>r.id===i.round);
        if(!owner?.legs.some(l=>l.wallet===i.wallet&&(i.action==='openPosition'?l.openIntent:l.closeIntent)===i.id))errors.push(`待确认交易请求 ${i.id} 不属于未完成轮次`);
      }
    }
    const totals=store.totals(),unresolvedOwnership=store.get('unresolvedOwnership');
    const nextAction=errors.length?'halt_invalid_checkpoint':unresolvedOwnership?'manual_review':r?.state==='opening'?
      (r.legs.some(l=>intents.find(i=>i.id===l.openIntent)?.state==='prepared')?'reconcile_incomplete_dispatch':'resume_existing_open_requests'):
      r?.state==='hedged'?'monitor_frozen_strategy':r?.state==='closing'?'resume_existing_close_requests':r?.state==='recovering'?'continue_recovery_exit':
      pending.length?'reconcile_pending_requests':'evaluate_strategy_after_live_sync';
    const result={
      version:1,source:'本地持久化断点；余额和请求结果仍须与官方实时状态核对',database:store.path,readAt:new Date(now).toISOString(),
      hasState:store.get('identity')!==null,market:store.get<string>('market'),wallets:addresses,
      integrityErrors:errors,nextAction,requiresLiveReconciliation:true,
      savedRuntime:store.get('runtimeCheckpoint'),lastStartup:store.get('checkpointStartup'),
      activeDataGap:store.get('activeDataGap'),lastDataGap:store.get('lastDataGap'),lastDataFailure:store.get('lastDataFailure'),
      activeOpeningDataGap:store.get('activeOpeningDataGap'),lastOpeningDataFailure:store.get('lastOpeningDataFailure'),tradingHealth:store.get('tradingHealth'),
      priceVolatility:new PriceVolatility(store.get<MinutePrice[]>('priceMinutes')??[]).estimate(now),
      oiAdmissionHealth:store.get('oiAdmissionHealth'),
      liveCloseDecision:store.get('liveCloseDecision'),
      stopRequested:store.get<boolean>('stopRequested'),tradeStoppedReason:store.get<string>('tradeStoppedReason'),unresolvedOwnership,
      nextOpenAttemptAt:store.get<number>('nextOpenAttemptAt'),
      activeRound:r?{id:r.id,state:r.state,reason:r.reason,createdAt:new Date(r.createdAt).toISOString(),firstFillAt:r.firstFillAt===undefined?null:new Date(r.firstFillAt).toISOString(),strategy:r.strategy??null,
        legs:r.legs.map(l=>({wallet:l.wallet,openIntent:l.openIntent,closeIntent:l.closeIntent,positionId:l.position?.id??l.settled?.id??null,settled:!!l.settled,
          openState:intents.find(i=>i.id===l.openIntent)?.state??null,closeState:intents.find(i=>i.id===l.closeIntent)?.state??null}))}:null,
      pendingIntents:pending.map(i=>({id:i.id,wallet:i.wallet,round:i.round,action:i.action,state:i.state,createdAt:new Date(i.createdAt).toISOString(),deadline:new Date(i.deadline*1000).toISOString(),deadlinePassedLocally:now>i.deadline*1000,ackRevision:i.ackRevision})),
      accounts:wallets.map(w=>({wallet:w.address,indexedAt:new Date(w.timestamp*1000).toISOString(),block:w.block,availableUsdc:usd(w.available),queuedUsdc:usd(w.queued),lockedUsdc:usd(w.locked),paper:usd(w.paper),stakedPaper:usd(w.staked),
        reservedRewardsUsdc:usd(store.get<{reserved:bigint}>(`rewardReserve:${w.address}`)?.reserved??0n)})),
      nonceCursors:addresses.map(wallet=>({wallet,exchange:store.get<string>(`nonce:${wallet}`),paper:store.get<string>(`nonce:paper:${wallet}`)})),
      sessionCache:addresses.map(wallet=>({wallet,active:store.get(`session:active:${wallet}`)!==null,candidate:store.get(`session:candidate:${wallet}`)!==null})),
      totals:{completedRounds:totals.rounds,settledPositions:totals.positions,netPnlUsdc:usd(totals.netPnl),paperMinted:usd(totals.paper)}
    };
    store.db.exec('COMMIT');return result;
  }catch(e){store.db.exec('ROLLBACK');throw e;}
}
