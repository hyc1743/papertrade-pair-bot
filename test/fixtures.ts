import { loadIdentities, encryptSession, newSession } from '../src/signing.js';
import { configSchema } from '../src/config.js';
import { amount } from '../src/util.js';
import { WAD, type Market, type Protocol, type Position, type Trading, type Wallet } from '../src/types.js';
import { Store } from '../src/store.js';

export const NOW=1_791_626_000_000;
export const identities=()=>loadIdentities({PAPERTRADE_WALLET_A_PRIVATE_KEY:'0x'+'1'.padStart(64,'0'),PAPERTRADE_WALLET_B_PRIVATE_KEY:'0x'+'2'.padStart(64,'0')});
export const market=():Market=>({id:0,symbol:'BTC',assetIndex:0,priceScale:10n,active:true,paused:false,retired:false,closeOnly:false,frozenBid:null,frozenAsk:null,rateMultiplier:15000n*WAD,positionMultiplier:amount('814.598'),maxLeverage:1000,maxNotional:amount('10000000'),bustBuffer:amount('0.0005'),baseRate:amount('0.1'),referenceNotional:amount('100000'),longOi:0n,shortOi:0n,longCap:amount('100000'),shortCap:amount('100000')});
export const trading=():Trading=>({block:100,paused:false,minMargin:amount('10'),minNotional:amount('10000'),markets:[market()],disabledActions:[],maxNetOi:amount('250000000'),minPaperStake:amount('1000')});
export const protocol=():Protocol=>({block:100,sourceAt:NOW,lpCash:0n,queue:0n,feesPending:0n,feesLifetime:0n,paper:{trackedLp:0n,tail:0n,cliff:amount('2000000'),cap:amount('5000000'),rate:amount('100'),decay:amount('120000000'),staked:0n,pendingRewards:0n}});
export const config=()=>configSchema.parse({marginUsdc:'500',leverage:20,maxNetLossUsdc:'100',stateDir:'/tmp/unused'});
export const wallet=(index=0):Wallet=>({address:identities()[index]!.address,revision:1,block:100,timestamp:NOW/1000,queueRevision:0n,balance:amount('1000'),queued:0n,locked:0n,available:amount('1000'),sessions:{},paper:0n,staked:0n,claimedRewards:0n,withdrawn:0n,realizedPnl:0n,positions:[],operations:[],closed:[],outcomes:[]});
export const position=(isLong=true,id='1'):Position=>({id,instrumentId:0,isLong,useDebt:false,entry:1_000_000n,margin:amount('500'),leverage:20,bust:isLong?950500n:1049500n,openedAtMs:NOW,intentId:null});
export function installSessions(store:Store,ws:[Wallet,Wallet]) {
  identities().forEach((identity,index)=>{const s=newSession(NOW);store.set(`session:active:${identity.address}`,encryptSession(s,identity));ws[index]!.sessions[s.address]=BigInt(s.expiry);});
}
export function walletFrame() {
  return {address:wallet().address,indexedThroughBlock:100,indexedThroughTimestamp:NOW/1000,walletRevision:0,queueRevision:'0',balance:String(amount('1000')),queued:'0',locked:'0',sessionKeys:[],queueNodeCount:0,consumableDebt:'0',funds:{reservedBalance:'0',reservedQueued:'0',availableBalance:String(amount('1000')),availableQueued:'0'},paper:{balance:'0',staked:'0',pendingBase:'0',rewardDebt:'0'},lifetime:{depositedRaw:String(amount('1000')),withdrawnRaw:'0',realizedPnlRaw:'0',feesPaidRaw:'0',tradedNotionalRaw:'0',paperRewardsClaimedRaw:'0'},openPositions:[],operations:[],accountRevision:1};
}
