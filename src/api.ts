import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { CHAIN_ID, EXCHANGE, PAPER_STAKING, ORIGIN, RPC, type ClosedPosition, type Intent, type Protocol, type Receipt, type Signed, type Trading } from './types.js';
import { decodeProtocol, decodeTrading } from './wire.js';
import { TYPES } from './signing.js';

const definitiveCodes=new Set(['invalid_intent','deadline_expired','unauthorized_intent','intent_conflict','admission_rejected','below_minimum_paper_stake','below_minimum_withdrawal','invalid_onward','intake_action_paused','rate_limited']);
export class ApiError extends Error {
  constructor(readonly status:number,readonly code:string,readonly definitive:boolean,readonly retryMs=0,readonly reason='') { super(`官方接口 ${status}: ${code}${reason?` (${reason})`:''}`); }
}
export interface TradingApi {
  trading(signal?:AbortSignal):Promise<Trading>; protocol(signal?:AbortSignal):Promise<Protocol>;
  submit(intent:Intent):Promise<Receipt>;
  cancel(id:Hex,signed:Signed):Promise<'cancelled'|'pending'>;
  history(wallet:Address,sinceMs:number):Promise<ClosedPosition[]>;
  pendingReward(wallet:Address,signal?:AbortSignal):Promise<bigint>;
  nonceUsed?(intent:Intent,block:number):Promise<boolean>;
}
const unsigned=z.string().regex(/^(0|[1-9]\d*)$/);
const hash=z.string().regex(/^0x[0-9a-f]{64}$/);
const receiptSchema=z.object({intentId:hash,action:z.enum(['registerSessionKey','openPosition','closePositions','paperStake','paperClaim']),state:z.enum(['queued','prepared','confirmed','failed','reverted','expired','cancelled']),queueRevision:unsigned});
const historyItem=z.object({positionId:unsigned,instrumentId:z.number().int().nonnegative(),isLong:z.boolean(),marginRaw:unsigned,leverage:z.number().int().positive(),kind:z.enum(['PositionClosed','Liquidated']),adjustedPnlRaw:z.string().regex(/^(0|-?[1-9]\d*)$/),userPaidFeeRaw:unsigned,paperMintedRaw:unsigned,timestampMs:z.number().int().nonnegative(),openedAtMs:z.number().int().nonnegative(),openIntentId:hash.optional()});
const historySchema=z.object({items:z.array(historyItem).max(200),nextCursor:z.string().min(1).nullable()});
export class Api implements TradingApi {
  build='';
  private cooldown={query:0,edge:0};
  constructor(readonly fetcher:typeof fetch=fetch) {}
  async request(path:string,body?:unknown,signal?:AbortSignal):Promise<unknown> {
    const bucket=path.startsWith('/query/')?'query':'edge';
    if(Date.now()<this.cooldown[bucket])throw new ApiError(429,'rate_limited',true,this.cooldown[bucket]-Date.now());
    const r=await this.fetcher(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{accept:'application/json','user-agent':'Mozilla/5.0',...(body===undefined?{}:{'content-type':'application/json',origin:ORIGIN,referer:ORIGIN+'/'}),...(this.build?{'X-Papertrade-Build':this.build}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
    const retryHeader=r.headers.get('retry-after');
    const retryDelay=retryHeader?(/^\d+$/.test(retryHeader)?Number(retryHeader)*1000:Math.max(0,Date.parse(retryHeader)-Date.now())):1000;
    if(r.status===429)this.cooldown[bucket]=Date.now()+(Number.isFinite(retryDelay)?Math.max(1000,retryDelay):1000);
    let data:unknown;
    try { data=await r.json(); } catch { throw new ApiError(r.status,'invalid_response',false); }
    const obj=data as Record<string,unknown>|null;
    if(!r.ok||obj?.error||obj?.ok===false) {
      const code=typeof obj?.code==='string'?obj.code:typeof obj?.error==='string'?obj.error:'request_failed';
      const retry=r.headers.get('retry-after');
      const retryMs=retry ? (/^\d+$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())) : 0;
      // Do not expose arbitrary server messages/payloads (possibly containing signed requests).
      const reason=typeof obj?.reason==='string' && /^[a-zA-Z_]{1,64}$/.test(obj.reason)?obj.reason:'';
      throw new ApiError(r.status,code,[400,403,409,422,429].includes(r.status)&&definitiveCodes.has(code),Number.isFinite(retryMs)?retryMs:0,reason);
    }
    return data;
  }
  trading=async(signal?:AbortSignal)=>decodeTrading(await this.request('/state/trading',undefined,signal));
  protocol=async(signal?:AbortSignal)=>decodeProtocol(await this.request('/query/protocol/summary',undefined,signal));
  async nonceUsed(intent:Intent,block:number):Promise<boolean> {
    if(!Number.isSafeInteger(block)||block<0)throw new Error('Invalid nonce evidence block');
    const tag='0x'+block.toString(16);
    const call=async(to:Address,data:Hex)=>{
      const r=await this.fetcher(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},tag]}),signal:AbortSignal.timeout(5000)});
      const v=await r.json() as {result?:string;error?:unknown};
      if(!r.ok||v.error||!v.result||!/^0x[0-9a-fA-F]{64}$/.test(v.result))throw new Error('无法读取链上 nonce 证据');return v.result;
    };
    let target=PAPER_STAKING;
    if(intent.action!=='paperStake'&&intent.action!=='paperClaim') {
      const raw=await call(EXCHANGE,encodeFunctionData({abi:parseAbi(['function sessionKeyManager() view returns(address)']),functionName:'sessionKeyManager'}));
      if(!/^0x0{24}[0-9a-fA-F]{40}$/.test(raw)||BigInt(raw)===0n)throw new Error('Invalid session manager');
      target=('0x'+raw.slice(-40)) as Address;
    }
    const result=BigInt(await call(target,encodeFunctionData({abi:parseAbi(['function isNonceUsed(address user,uint256 nonce) view returns(bool)']),functionName:'isNonceUsed',args:[intent.wallet,BigInt(String(intent.signed.nonce))]})));
    if(result!==0n&&result!==1n)throw new Error('Invalid nonce result');return result===1n;
  }
  async pendingReward(wallet:Address,signal?:AbortSignal):Promise<bigint> {
    const data=encodeFunctionData({abi:parseAbi(['function pendingReward(address user) view returns (uint256)']),functionName:'pendingReward',args:[wallet]});
    const r=await this.fetcher(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:PAPER_STAKING,data},'latest']}),signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
    const value=await r.json() as {result?:string;error?:unknown};
    if(!r.ok||value.error||!value.result||!/^0x[0-9a-fA-F]{64}$/.test(value.result))throw new Error('无法读取链上可领取 USDC');
    return BigInt(value.result);
  }
  async submit(i:Intent):Promise<Receipt> {
    const r=receiptSchema.parse(await this.request('/intents',{action:i.action,signed:i.signed}));
    if(r.intentId!==i.id || r.action!==i.action) throw new ApiError(200,'intent_identity_mismatch',false);
    return {...r,intentId:r.intentId as Hex,queueRevision:BigInt(r.queueRevision)};
  }
  async cancel(id:Hex,signed:Signed):Promise<'cancelled'|'pending'> {
    const {intentId:ignored,...body}=signed;
    const r=z.object({intentId:hash,action:z.string(),state:z.string()}).parse(await this.request(`/intents/${id}/cancel`,body));
    if(r.intentId!==id) throw new ApiError(200,'intent_identity_mismatch',false);
    return r.state==='cancelled'?'cancelled':'pending';
  }
  async history(wallet:Address,sinceMs:number):Promise<ClosedPosition[]> {
    const result:ClosedPosition[]=[],seen=new Set<string>(); let cursor:string|null=null;
    for(let page=0;page<200;page++) {
      const query=new URLSearchParams({limit:'75',filter:'all'}); if(cursor) query.set('cursor',cursor);
      // The query service rejects non-canonical parameter order with HTTP 400 (not a redirect).
      query.sort();
      const f=historySchema.parse(await this.request(`/query/accounts/${wallet}/trades?${query}`));
      for(const x of f.items) if(x.timestampMs>=sinceMs) result.push({id:x.positionId,instrumentId:x.instrumentId,isLong:x.isLong,margin:BigInt(x.marginRaw),leverage:x.leverage,liquidated:x.kind==='Liquidated',netPnl:BigInt(x.adjustedPnlRaw)-BigInt(x.userPaidFeeRaw),paper:BigInt(x.paperMintedRaw),closedAtMs:x.timestampMs,openedAtMs:x.openedAtMs,...(x.openIntentId?{openIntentId:x.openIntentId as Hex}:{})});
      if(!f.nextCursor || f.items.some(x=>x.timestampMs<sinceMs)) return result;
      if(seen.has(f.nextCursor)) throw new Error('历史接口返回重复游标');
      seen.add(f.nextCursor); cursor=f.nextCursor;
    }
    throw new Error('历史对账超出分页限制；禁止跳过未核实结算');
  }
  async verify():Promise<void> {
    const rpc=async(method:string,params:unknown[])=>{
      const r=await this.fetcher(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
      const data=await r.json() as {result?:string;error?:unknown};
      if(!r.ok||data.error||typeof data.result!=='string') throw new Error('无法验证 HyperEVM 部署'); return data.result;
    };
    if(BigInt(await rpc('eth_chainId',[]))!==BigInt(CHAIN_ID) || (await rpc('eth_getCode',[EXCHANGE,'latest'])).length<=2 || (await rpc('eth_getCode',[PAPER_STAKING,'latest'])).length<=2) throw new Error('链或 Exchange/Staking 部署不匹配');
    const text=async(path:string)=>{
      const ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      let s:string;
      try {
        const r=await this.fetcher(ORIGIN+path,{headers:{accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','user-agent':ua,referer:'https://papertrade.xyz/'},signal:AbortSignal.timeout(10000),redirect:'error'});
        if(!r.ok)throw new Error();s=await r.text();
      }catch {
        if(this.fetcher!==fetch)throw new Error('无法验证官方前端签名模板');
        // Some edges reject Node's fetch metadata for HTML. curl is a read-only bootstrap fallback;
        // it is NEVER used for RPC writes, signed requests, environment variables or secrets.
        const publicEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PAPERTRADE_WALLET_[AB]_PRIVATE_KEY$/.test(key)));
        try {s=(await promisify(execFile)('curl',['-f','-sS','--max-time','10','-A',ua,'-H','Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','-H','Referer: https://papertrade.xyz/',ORIGIN+path],{encoding:'utf8',maxBuffer:2_000_000,timeout:12000,env:publicEnv})).stdout;}
        catch{throw new Error('无法验证官方前端签名模板（fetch/curl 均失败）');}
      }
      if(s.length>2_000_000)throw new Error('官方资源大小异常');return s;
    };
    const html=await text('/');
    const asset=(name:string)=>{const match=html.match(new RegExp(`(?:src|href)="(/assets/${name}-[A-Za-z0-9_-]+\\.js)"`)); if(!match?.[1]) throw new Error(`官方 ${name} 模块结构变更`); return match[1];};
    // The official frontend moved its pinned deployment from deployment-* into
    // wire-*. Check the exact deployed contract fields in either build layout.
    const deploymentModule=html.includes('/assets/deployment-')?'deployment':'wire';
    const [deployment,types,build]=await Promise.all([text(asset(deploymentModule)),text(asset('typed-data')),text(asset('build'))]);
    const contracts=deploymentModule==='wire'?`contracts:{exchange:\`${EXCHANGE}\``:`exchange:\`${EXCHANGE}\``;
    if(!deployment.includes(contracts) || !deployment.includes(`paperStaking:\`${PAPER_STAKING}\``) || !deployment.includes(`chainId:${CHAIN_ID}`)) throw new Error('官方部署已变更，请更新适配器');
    // The current official bundle is minified template literals. Reject format/schema drift; never evaluate downloaded code.
    for(const [name,fields] of Object.entries(TYPES)) {
      const expected=`${name}:[${fields.map(f=>`{name:\`${f.name}\`,type:\`${f.type}\`}`).join(',')}]`;
      if(!types.includes(expected)) throw new Error('官方 EIP-712 字段已变更，请更新适配器');
    }
    if(!types.includes('exchange:{name:`String`,version:`1`}') || !types.includes('paperStaking:{name:`PaperStaking`,version:`1`}') || !types.includes('cancellation:{name:`PaperTrade Intent Cancel`,version:`2`}') || !types.includes('papertrade:intent-id:v2')) throw new Error('官方签名域或 intent ID 版本已变更');
    const match=build.match(/`([0-9a-f]{12})`/); if(!match?.[1]) throw new Error('无法验证前端版本'); this.build=match[1];
  }
}
