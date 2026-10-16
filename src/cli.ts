import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Api } from './api.js';
import { loadConfig } from './config.js';
import { Engine } from './engine.js';
import { checkOpen, estimatePaper, estimateRoundCost } from './math.js';
import { decideStrategy, effectiveConfig } from './strategy.js';
import { loadIdentities } from './signing.js';
import { acquireLock, Store } from './store.js';
import { Quotes, WalletStream } from './streams.js';
import { amount, delay, errorText, json, max, usd } from './util.js';
import type { Protocol, Wallet } from './types.js';
import { openingSchedule, parseOpeningAt } from './schedule.js';
import { readCheckpoint } from './checkpoint.js';
import { applyEfficiencyRetarget, applyRetarget, inspectEfficiencyRetarget, inspectRetarget } from './retarget.js';

const HELP=`Papertrade 双账户脚本（Node.js 24+）

npm run cli -- preflight [--config config.json]
npm run cli -- run --live [--config config.json] [--max-rounds 1] [--opening-at YYYY-MM-DDT14:00:00Z]
npm run cli -- rewards --live [--config config.json]
npm run cli -- status [--state-dir ./data]
npm run cli -- report [--state-dir ./data]
npm run cli -- checkpoint [--state-dir ./data]
npm run cli -- retarget --config config.example.json --state-dir ./data --round <ID> --close-bps <BPS> [--confirm-retarget]
npm run cli -- optimize-close --config config.example.json --state-dir ./data --round <ID> [--confirm-retarget]
npm run cli -- stop [--state-dir ./data]

资金与杠杆必须填写配置；两个钱包私钥从 PAPERTRADE_WALLET_A_PRIVATE_KEY / PAPERTRADE_WALLET_B_PRIVATE_KEY 读取。
preflight 只读；run --live 可交易并质押/领取，rewards --live 仅质押/领取。stop 退出存量仓位并停止全部任务。
`;
function stateDir(configPath:string,override?:string):string {
  if(override)return resolve(override);
  if(existsSync(configPath)) {const data=JSON.parse(readFileSync(configPath,'utf8'));if(typeof data.stateDir==='string')return resolve(data.stateDir);}
  return resolve('./data');
}
function overview(store:Store,details:boolean) {
  const totals=store.totals(),r=store.activeRound();
  const wallets=store.snapshots();
  const claimed=wallets.reduce((v,w)=>v+max(0n,(w.claimedRewards??0n)-BigInt(store.get<string>(`claimedBaseline:${w.address}`)??String(w.claimedRewards??0n))),0n);
  const lp=store.get<{protocol:Protocol;checkedAt:number}>('protocolSnapshot');
  const result={
    snapshotKind:'本地持久化快照，非实时余额',market:store.get('market'),openingSchedule:store.get('openingSchedule'),
    stopRequested:store.get('stopRequested'),lastStopReason:store.get('lastStopReason'),protocolHealth:store.get('protocolHealth'),unresolvedOwnership:store.get('unresolvedOwnership'),
    tradeStoppedReason:store.get('tradeStoppedReason'),nextStrategy:store.get('strategyDecision'),
    liveCloseDecision:store.get('liveCloseDecision'),
    checkpointStartup:store.get('checkpointStartup'),runtimeCheckpoint:store.get('runtimeCheckpoint'),
    recentIntentErrors:store.intents().slice(-20).flatMap(i=>{const e=store.get(`intentLastError:${i.id}`);return e?[e]:[];}),
    lp:lp?{checkedAt:new Date(lp.checkedAt).toISOString(),sourceAt:new Date(lp.protocol.sourceAt).toISOString(),cashUsdc:usd(lp.protocol.lpCash),trackedLpUsdc:usd(lp.protocol.paper.trackedLp),queuedUsdc:usd(lp.protocol.queue),tailProgressUsdc:usd(lp.protocol.paper.tail)}:null,
    activeRound:r?{id:r.id,state:r.state,reason:r.reason,strategy:r.strategy,legs:r.legs.map(l=>({wallet:l.wallet,positionId:l.position?.id??null,settled:!!l.settled,openState:store.intent(l.openIntent)?.state,closeState:l.closeIntent?store.intent(l.closeIntent)?.state:null}))}:null,
    totals:{rounds:totals.rounds,settledPositions:totals.positions,netPnlUsdc:usd(totals.netPnl),netLossUsdc:usd(max(0n,-totals.netPnl)),paperMinted:usd(totals.paper),claimedRewardsUsdc:usd(claimed),netIncludingClaimedRewardsUsdc:usd(totals.netPnl+claimed),note:'交易净损耗包含尚未支付的盈利债权；PAPER 和未领取分配不计作 USDC 收入'},
    accounts:wallets.map(w=>{const pending=store.get<{amount:bigint;checkedAt:number}>(`pendingReward:${w.address}`),reserve=store.get<{reserved:bigint}>(`rewardReserve:${w.address}`);return{address:w.address,indexedAt:new Date(w.timestamp*1000).toISOString(),availableUsdc:usd(w.available),rewardReserveUsdc:usd(reserve?.reserved??0n),queuedUsdc:usd(w.queued),lockedUsdc:usd(w.locked),paper:usd(w.paper),stakedPaper:usd(w.staked),claimedRewardsLifetimeUsdc:usd(w.claimedRewards??0n),pendingRewardUsdc:pending?usd(pending.amount):null,pendingRewardCheckedAt:pending?new Date(pending.checkedAt).toISOString():null};}),
    ...(details?{rounds:store.rounds().map(r=>({id:r.id,state:r.state,strategy:r.strategy,startedAt:new Date(r.createdAt).toISOString(),reason:r.reason,legs:r.legs.map(l=>({wallet:l.wallet,positionId:l.position?.id??null,netPnlUsdc:l.settled?usd(l.settled.netPnl):null,paper:l.settled?usd(l.settled.paper):null,liquidated:l.settled?.liquidated??false}))}))}:{})
  };
  console.log(JSON.stringify(result,null,2));
}
async function main() {
  process.umask(0o077);
  const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string',default:'config.json'},'state-dir':{type:'string'},'max-rounds':{type:'string'},'opening-at':{type:'string'},round:{type:'string'},'close-bps':{type:'string'},'confirm-retarget':{type:'boolean',default:false},'accept-immediate-close':{type:'boolean',default:false},live:{type:'boolean',default:false},help:{type:'boolean',short:'h'}}});
  const command=positionals[0];
  if(values.help||!command){console.log(HELP);return;}
  if(values['opening-at']&&command!=='run'&&command!=='preflight')throw new Error('--opening-at 仅适用于 run 或 preflight');
  if(positionals.length!==1||!['preflight','run','rewards','status','report','checkpoint','retarget','optimize-close','stop'].includes(command))throw new Error('未知命令；使用 --help 查看用法');
  const path=resolve(values.config);
  if(command==='retarget'||command==='optimize-close') {
    if(!values.round||!/^[1-9]\d*$/.test(values.round)||command==='retarget'&&(!values['close-bps']||!/^[1-9]\d*$/.test(values['close-bps'])))throw new Error('必须指定正整数 --round；retarget 还需要 --close-bps');
    const roundId=Number(values.round),targetBps=command==='retarget'?Number(values['close-bps']):0;
    if(!Number.isSafeInteger(roundId)||!Number.isSafeInteger(targetBps))throw new Error('轮次或阈值过大');
    const config=loadConfig(path),dir=stateDir(path,values['state-dir']);
    if(!Store.exists(dir))throw new Error('状态数据库不存在');
    if(values['confirm-retarget']) {
      let pid:number;
      try {pid=JSON.parse(readFileSync(join(dir,'run.lock'),'utf8')).pid;if(!Number.isInteger(pid)||pid<=0)throw new Error();process.kill(pid,0);}
      catch {throw new Error('未检测到运行中的脚本；拒绝修改实时仓位策略');}
    }
    const store=new Store(dir,!values['confirm-retarget']);let quotes:Quotes|undefined;
    try {
      const checkpoint=readCheckpoint(store);if(checkpoint.integrityErrors.length)throw new Error(`断点状态无效：${checkpoint.integrityErrors.join('; ')}`);
      if(checkpoint.market!==config.market)throw new Error('轮次市场与配置不匹配');
      const r=store.activeRound();if(!r?.strategy)throw new Error('当前没有可热更新的持仓策略');
      const api=new Api(),[trading,protocol]=await Promise.all([api.trading(),api.protocol()]);
      const market=trading.markets.find(m=>m.symbol===config.market);if(!market)throw new Error('目标市场不可用');
      quotes=new Quotes(market);quotes.start();const deadline=Date.now()+8000;
      while(Date.now()<deadline&&(!quotes.latest||Date.now()-quotes.latest.receivedAt>config.quoteMaxAgeMs))await delay(100);
      const quote=quotes.latest;if(!quote)throw new Error('无法取得新鲜 BBO 行情，拒绝热更新');
      const input={config,trading,market,protocol,quote,roundId,expectedBps:r.strategy.closeMoveBps,targetBps,now:Date.now(),acceptImmediateClose:values['accept-immediate-close']};
      const result=command==='optimize-close'?
        values['confirm-retarget']?applyEfficiencyRetarget(store,input):inspectEfficiencyRetarget(store,input):
        values['confirm-retarget']?applyRetarget(store,input):inspectRetarget(store,input);
      console.log(JSON.stringify({mode:values['confirm-retarget']?'已提交实时轮次热更新':'只读预览，未修改轮次',...result},null,2));
      if(!values['confirm-retarget']&&!result.allowed)process.exitCode=2;
    }finally{quotes?.stop();store.close();}
    return;
  }
  if(['status','report','checkpoint','stop'].includes(command)) {
    const dir=stateDir(path,values['state-dir']);
    if(!Store.exists(dir)) {console.log('尚无状态数据库');return;}
    const store=new Store(dir,command!=='stop');
    try {if(command==='stop'){store.set('stopRequested',true);store.set('lastStopReason','用户停止');console.log('已请求停止新开仓并退出脚本存量仓位；用 status 查看结果。');}else if(command==='checkpoint'){console.log(JSON.stringify(readCheckpoint(store),null,2));}else overview(store,command==='report');}finally{store.close();}
    return;
  }
  if(['run','rewards'].includes(command)&&!values.live)throw new Error(`实盘运行必须显式指定 ${command} --live；只读检查使用 preflight`);
  const config=loadConfig(path);if(values['state-dir'])config.stateDir=resolve(values['state-dir']);
  if(values['opening-at']){parseOpeningAt(values['opening-at']);config.openingAtUtc=values['opening-at'];}
  if(values['max-rounds']) {if(!/^[1-9]\d*$/.test(values['max-rounds']))throw new Error('--max-rounds 必须是正整数');config.maxRounds=Number(values['max-rounds']);if(!Number.isSafeInteger(config.maxRounds))throw new Error('轮数过大');}
  const identities=loadIdentities(),api=new Api();
  // A run must take the lock before any mutable state or signed relayer request.
  const release=command==='preflight'?()=>{}:acquireLock(config.stateDir);
  try {
    await api.verify();
    if(command==='preflight') {
      const [trading,protocol]=await Promise.all([api.trading(),api.protocol()]);
      const market=trading.markets.find(m=>m.symbol===config.market);if(!market)throw new Error('市场未发布');
      const streams=identities.map(i=>new WalletStream(i.address,()=>{})),quotes=new Quotes(market);
      for(const s of streams)s.start();quotes.start();
      try {
        const deadline=Date.now()+20000;
        while(Date.now()<deadline&&(!streams.every(s=>s.current)||!quotes.latest))await delay(100);
        const wallets=streams.map(s=>s.latest).filter((w):w is Wallet=>!!w);
        const q=quotes.latest;
        let tradeWallets=wallets,existingPnl=0n,completed=0;
        let checkpoint:ReturnType<typeof readCheckpoint>|null=null;
        const stateErrors:string[]=[];
        if(Store.exists(config.stateDir)) {
          const cached=new Store(config.stateDir,true);
          try {
            checkpoint=readCheckpoint(cached);stateErrors.push(...checkpoint.integrityErrors);
            if(checkpoint.activeRound||checkpoint.pendingIntents.length)stateErrors.push('存在未完成断点；启动后先恢复旧请求，不直接开启新轮次');
            if(checkpoint.unresolvedOwnership)stateErrors.push('存在尚未核实的历史仓位归属');
            const identity=cached.get<string>('identity');
            if(identity&&identity!==`${identities.map(i=>i.address).join(':')}:${config.market}`)stateErrors.push('钱包或市场与状态库不匹配');
            const totals=cached.totals();existingPnl=totals.netPnl;completed=totals.rounds;
            if(config.reserveClaimedRewards)tradeWallets=wallets.map(w=>{
              const old=cached.get<{reserved:bigint;claimed:bigint;withdrawn:bigint}>(`rewardReserve:${w.address}`);
              const reserve=old?max(0n,old.reserved+max(0n,w.claimedRewards-old.claimed)-max(0n,w.withdrawn-old.withdrawn)):0n;
              return {...w,available:max(0n,w.available-reserve)};
            });
          }finally{cached.close();}
        }
        const decision=decideStrategy(config,trading,market,protocol,tradeWallets,Date.now());
        const chosen=effectiveConfig(config,decision);
        const errors=wallets.length===2&&streams.every(s=>s.current)?[...stateErrors,...decision.reasons,...checkOpen(chosen,trading,market,tradeWallets,q?.mid??0n)]:['无法取得两个账户的完整快照'];
        const schedule=openingSchedule(config.openingAtUtc,config.openingCheckLeadMs,Date.now());
        if(!schedule.canOpen)errors.push('未到配置的 UTC 开放时间；run --live 将等待');
        if(!q||Date.now()-q.time>config.quoteMaxAgeMs)errors.push('没有新鲜的 BBO 行情');
        const cost=estimateRoundCost(market,amount(chosen.marginUsdc),chosen.leverage,chosen.closeMoveBps+config.maxEntryGapBps);
        if(config.maxNetLossUsdc!==null&&cost>amount(config.maxNetLossUsdc)+existingPnl)errors.push('剩余损耗预算不足以覆盖预计一轮');
        if(config.maxRounds!==null&&completed>=config.maxRounds)errors.push('已达到累计交易轮数上限，仍可运行奖励监控');
        const output={mode:'只读，未提交授权或交易',openingSchedule:schedule,checkpoint,accounts:wallets.map(w=>({address:w.address,availableUsdc:usd(w.available),tradeSpendableUsdc:usd(tradeWallets.find(x=>x.address===w.address)!.available),queuedUsdc:usd(w.queued),existingPositions:w.positions.length,pendingOperations:w.operations.length})),
          market:market.symbol,minimumMarginUsdc:usd(trading.minMargin),minimumNotionalUsdc:usd(trading.minNotional),minimumPaperStake:usd(trading.minPaperStake),configuredNotionalUsdc:config.targetNotionalUsdc??usd(amount(config.marginUsdc)*BigInt(config.leverage)),autoLeverage:config.autoLeverage,lpPollIntervalMs:config.lpPollIntervalMs,
          strategy:decision,maxNetLossUsdc:config.maxNetLossUsdc,autoStake:config.autoStake,autoClaim:config.autoClaim,
          expectedAtSelectedBps:{closeMoveBps:chosen.closeMoveBps,netCashShortfallUsdc:usd(cost),paperMintedEstimate:usd(estimatePaper(amount(chosen.marginUsdc)*BigInt(chosen.leverage)*BigInt(chosen.closeMoveBps)/10000n,protocol)),note:'基于文档手续费和当前参数的估计，不是成交承诺'},
          session:'run --live 时自动注册或恢复，不在 preflight 授权',ready:errors.length===0,errors};
        console.log(JSON.stringify(output,null,2));if(errors.length)process.exitCode=2;
      } finally {for(const s of streams)s.stop();quotes.stop();}
      return;
    }
    const store=new Store(config.stateDir);let engine:Engine|undefined;
    const stopping=()=>engine?.requestStop('进程退出请求');
    process.on('SIGINT',stopping);process.on('SIGTERM',stopping);
    try {
      if(command==='rewards'&&!config.autoStake&&!config.autoClaim)throw new Error('rewards 模式需要开启 autoStake 或 autoClaim');
      engine=new Engine(config,identities,store,api,{rewardsOnly:command==='rewards'});
      await engine.run();overview(store,false);if(engine.failureReason)process.exitCode=3;
    } finally {process.off('SIGINT',stopping);process.off('SIGTERM',stopping);store.close();}
  } finally {release();}
}
main().catch(e=>{console.error(json({error:errorText(e)}));process.exitCode=1;});
