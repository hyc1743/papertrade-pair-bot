import type { Address } from 'viem';
import type { Config } from './config.js';
import type { TradingApi } from './api.js';
import type { Identity } from './signing.js';
import { signIntent } from './signing.js';
import { Store } from './store.js';
import { amount, errorText, log, usd } from './util.js';
import type { Intent, Trading, Wallet } from './types.js';

export const isReward=(i:Intent)=>i.action==='paperStake'||i.action==='paperClaim';
const done=(i:Intent)=>['succeeded','failed','expired','cancelled'].includes(i.state);
export interface RewardContext { wallets:Wallet[]; current:(wallet:Address)=>boolean; trading:Trading|null; tradingAt:number; allowed:boolean }

/** Independent per-wallet workers: mint SSEs can stake while the other leg is still confirming. */
export class Rewards {
  private jobs=new Map<Address,Promise<void>>(); private dirty=new Set<Address>();
  private nextRead=new Map<Address,number>(); private nextAttempt=new Map<Address,number>();
  private stopped=false;
  constructor(private config:Config,private ids:[Identity,Identity],private store:Store,private api:TradingApi,
    private context:()=>RewardContext,private submit:(i:Intent)=>Promise<void>,private now:()=>number=Date.now) {}
  wake() {
    if(this.stopped||!this.config.autoStake&&!this.config.autoClaim)return;
    for(const id of this.ids) {
      if(this.jobs.has(id.address)){this.dirty.add(id.address);continue;}
      this.launch(id);
    }
  }
  private launch(id:Identity) {
    if(this.stopped)return;
    const job=this.pump(id).catch(e=>log('rewards_waiting',{wallet:id.address,error:errorText(e)})).finally(()=>{
      this.jobs.delete(id.address);
      if(this.dirty.delete(id.address)&&!this.stopped)this.launch(id);
    });
    this.jobs.set(id.address,job);
  }
  async drain() {while(this.jobs.size)await Promise.all([...this.jobs.values()]);}
  async shutdown() {this.stopped=true;this.dirty.clear();await this.drain();}
  private async pump(identity:Identity) {
    const ctx=this.context(),w=ctx.wallets.find(w=>w.address===identity.address);
    if(!ctx.allowed||!ctx.current(identity.address)||!ctx.trading||!w||this.now()-ctx.tradingAt>5000)return;
    const pending=this.store.intents().find(i=>i.wallet===w.address&&isReward(i)&&!done(i));
    if(pending){
      if(pending.state==='prepared') {
        if(pending.deadline<=Math.floor(this.now()/1000))this.store.updateIntent(pending.id,'expired');
        else if(!ctx.trading.disabledActions.includes(pending.action)) {
          if(pending.action==='paperStake'&&(w.paper<BigInt(String(pending.signed.amount))||BigInt(String(pending.signed.amount))<ctx.trading.minPaperStake))this.store.updateIntent(pending.id,'cancelled');
          else await this.submit(pending);
        }
      }
      return;
    }
    if(w.operations.some(o=>o.action==='paperStake'||o.action==='paperClaim'||o.action==='paperUnstake'))return;
    if(this.now()<(this.nextAttempt.get(w.address)??0))return;
    if(this.config.autoStake&&w.paper>0n&&w.paper>=ctx.trading.minPaperStake&&!ctx.trading.disabledActions.includes('paperStake')) {
      await this.prepare(identity,w,'paperStake',w.paper);return;
    }
    if(!this.config.autoClaim||w.staked===0n||ctx.trading.disabledActions.includes('paperClaim')||this.now()<(this.nextRead.get(w.address)??0))return;
    this.nextRead.set(w.address,this.now()+this.config.rewardPollIntervalMs);
    const pendingReward=await this.api.pendingReward(w.address);
    this.store.set(`pendingReward:${w.address}`,{amount:pendingReward,checkedAt:this.now()});
    if(pendingReward>=amount(this.config.minClaimUsdc))await this.prepare(identity,w,'paperClaim',pendingReward);
  }
  private async prepare(id:Identity,w:Wallet,action:'paperStake'|'paperClaim',quantity:bigint) {
    const deadline=Math.floor(this.now()/1000)+this.config.intentTtlSeconds;
    const message={user:w.address,nonce:this.store.nonce(w.address,'paper'),deadline:BigInt(deadline),...action==='paperStake'?{amount:quantity}:{}};
    const result=await signIntent(id.master,action==='paperStake'?'Stake':'Claim',message);
    const ctx=this.context(),latest=ctx.wallets.find(x=>x.address===w.address);
    if(this.stopped||!ctx.allowed||!ctx.current(w.address)||!ctx.trading||this.now()-ctx.tradingAt>5000||ctx.trading.disabledActions.includes(action)||!latest)return;
    if(action==='paperStake'&&(latest.paper<quantity||quantity<ctx.trading.minPaperStake))return;
    if(this.store.intents().some(i=>i.wallet===w.address&&isReward(i)&&!done(i)))return;
    const i:Intent={id:result.id,wallet:w.address,round:null,action,signed:result.signed,state:'prepared',deadline,createdAt:this.now(),ackRevision:null};
    this.store.transaction(()=>{
      this.store.set(`rewardBefore:${i.id}`,{staked:w.staked,claimed:w.claimedRewards,quantity});
      this.store.prepare(i);
    });
    this.nextAttempt.set(w.address,this.now()+1000);
    log('reward_submitting',{wallet:w.address,action,quantity:usd(quantity)});
    await this.submit(i);
    // Definitive rejection backs off; unknown acknowledgement remains reserved until reconciled.
    if(this.store.intent(i.id)?.state==='failed')this.nextAttempt.set(w.address,this.now()+30000);
  }
}
