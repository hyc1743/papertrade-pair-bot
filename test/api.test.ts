import test from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { Api, ApiError } from '../src/api.js';
import { EXCHANGE, PAPER_STAKING } from '../src/types.js';
import type { Intent } from '../src/types.js';
import { TYPES } from '../src/signing.js';
import { identities, NOW } from './fixtures.js';

const id=('0x'+'a'.repeat(64)) as Hex;
const intent:Intent={id,wallet:identities()[0].address,round:1,action:'openPosition',state:'prepared',deadline:NOW/1000+3600,createdAt:NOW,ackRevision:null,signed:{user:identities()[0].address,useDebt:false,r:'0x'+'1'.repeat(64),s:'0x'+'2'.repeat(64),v:'27'}};
const response=(data:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
test('exact receipt identity is required; a 200 status is not enough',async()=>{
  const api=new Api(async()=>response({intentId:id,action:'openPosition',state:'queued',queueRevision:'42'}));
  assert.equal((await api.submit(intent)).queueRevision,42n);
  const mismatched=new Api(async()=>response({intentId:'0x'+'b'.repeat(64),action:'openPosition',state:'queued',queueRevision:'42'}));
  await assert.rejects(mismatched.submit(intent),(e:unknown)=>e instanceof ApiError&&!e.definitive);
});
test('definitive admission failure is distinguished from transport uncertainty',async()=>{
  const rejected=new Api(async()=>response({error:'admission_rejected',reason:'funding'},422));
  await assert.rejects(rejected.submit(intent),(e:unknown)=>e instanceof ApiError&&e.definitive&&e.reason==='funding');
  const unknown=new Api(async()=>new Response('<html>bad gateway</html>',{status:502}));
  await assert.rejects(unknown.submit(intent),(e:unknown)=>e instanceof ApiError&&!e.definitive);
});
test('429 Retry-After throttles the entire edge before another request',async()=>{
  let calls=0;const api=new Api(async()=>{calls++;return response({error:'rate_limited'},429,{'retry-after':'30'});});
  await assert.rejects(api.submit(intent),ApiError);await assert.rejects(api.submit(intent),ApiError);assert.equal(calls,1);
});
test('cancel sends the signed cancellation body without embedding intentId',async()=>{
  let body:Record<string,unknown>|null=null;
  const api=new Api(async(_url,options)=>{body=JSON.parse(String(options?.body));return response({intentId:id,action:'openPosition',state:'cancelled'});});
  assert.equal(await api.cancel(id,{user:intent.wallet,intentId:id,deadline:String(intent.deadline),r:'0x1',s:'0x2',v:'27'}),'cancelled');
  assert(body);assert(!('intentId' in body));
});
test('history deducts paid user fee, identifies liquidation and rejects repeating cursors',async()=>{
  const item={positionId:'1',instrumentId:0,isLong:true,marginRaw:'1000',leverage:20,kind:'PositionClosed',adjustedPnlRaw:'100',userPaidFeeRaw:'2',paperMintedRaw:'0',timestampMs:NOW,openedAtMs:NOW-1000};
  const api=new Api(async()=>response({items:[item],nextCursor:null}));assert.equal((await api.history(intent.wallet,NOW-5000))[0]!.netPnl,98n);
  const loop=new Api(async()=>response({items:[item],nextCursor:'same'}));await assert.rejects(loop.history(intent.wallet,NOW-5000),/重复游标/);
});
test('bootstrap checks pinned deployment and signature fields without executing remote JS',async()=>{
  const html='<script src="/assets/deployment-x.js"></script><script src="/assets/typed-data-x.js"></script><script src="/assets/build-x.js"></script>';
  const types=Object.entries(TYPES).map(([n,fields])=>`${n}:[${fields.map(f=>`{name:\`${f.name}\`,type:\`${f.type}\`}`).join(',')}]`).join(',')+',exchange:{name:`String`,version:`1`},paperStaking:{name:`PaperStaking`,version:`1`},cancellation:{name:`PaperTrade Intent Cancel`,version:`2`},`papertrade:intent-id:v2`';
  const fetcher=(bad=false):typeof fetch=>async(url,options)=>{
    const u=String(url);
    if(u.includes('/evm')) {const b=JSON.parse(String(options?.body));return response({result:b.method==='eth_chainId'?'0x3e7':'0x1234'});}
    if(u.endsWith('/'))return new Response(html);
    if(u.includes('deployment'))return new Response(`chainId:999,exchange:\`${EXCHANGE}\`,paperStaking:\`${PAPER_STAKING}\``);
    if(u.includes('typed-data'))return new Response(bad?types.replace('String','Wrong'):types);
    return new Response('var e=`89e62bec3f93`;');
  };
  const api=new Api(fetcher());await api.verify();assert.equal(api.build,'89e62bec3f93');
  await assert.rejects(new Api(fetcher(true)).verify(),/签名域/);
});
test('bootstrap accepts the newer pinned wire deployment bundle but rejects changed contracts',async()=>{
  const html='<script src="/assets/wire-x.js"></script><script src="/assets/typed-data-x.js"></script><script src="/assets/build-x.js"></script>';
  const types=Object.entries(TYPES).map(([n,fields])=>`${n}:[${fields.map(f=>`{name:\`${f.name}\`,type:\`${f.type}\`}`).join(',')}]`).join(',')+',exchange:{name:`String`,version:`1`},paperStaking:{name:`PaperStaking`,version:`1`},cancellation:{name:`PaperTrade Intent Cancel`,version:`2`},`papertrade:intent-id:v2`';
  const fetcher=(bad=false):typeof fetch=>async(url,options)=>{
    const u=String(url);
    if(u.includes('/evm')){const b=JSON.parse(String(options?.body));return response({result:b.method==='eth_chainId'?'0x3e7':'0x1234'});}
    if(u.endsWith('/'))return new Response(html);
    if(u.includes('/wire-'))return new Response(`chainId:999,contracts:{exchange:\`${bad?'0x'+'0'.repeat(40):EXCHANGE}\`,paperStaking:\`${PAPER_STAKING}\``);
    if(u.includes('typed-data'))return new Response(types);
    return new Response('var e=`89e62bec3f93`;');
  };
  await new Api(fetcher()).verify();
  await assert.rejects(new Api(fetcher(true)).verify(),/官方部署已变更/);
});
test('pending rewards are read by eth_call from the pinned staking contract, never a transaction',async()=>{
  let request:Record<string,unknown>={};
  const api=new Api(async(_url,options)=>{request=JSON.parse(String(options?.body));return response({result:'0x'+(2n*10n**18n).toString(16).padStart(64,'0')});});
  assert.equal(await api.pendingReward(intent.wallet),2n*10n**18n);assert(request);assert.equal(request.method,'eth_call');
  const params=request.params as [{to:string;data:string},string];assert.equal(params[0].to,PAPER_STAKING);assert.equal(params[1],'latest');
  await assert.rejects(new Api(async()=>response({error:{message:'revert'}})).pendingReward(intent.wallet),/无法读取/);
});

test('nonce evidence uses only eth_call at the account indexed block',async()=>{
  const calls:Record<string,unknown>[]=[];
  const api=new Api(async(_url,options)=>{const q=JSON.parse(String(options?.body));calls.push(q);return response({result:'0x'+'0'.repeat(63)+'1'});});
  assert.equal(await api.nonceUsed({...intent,action:'paperStake',signed:{nonce:'9'}},123),true);
  assert.equal(calls[0]!.method,'eth_call');assert.equal((calls[0]!.params as unknown[])[1],'0x7b');
  assert.equal(((calls[0]!.params as unknown[])[0] as {to:string}).to,PAPER_STAKING);
});

test('history uses canonical sorted query parameters for both initial and cursor pages',async()=>{
  const paths:string[]=[];
  const api=new Api(async(url,options)=>{
    assert.equal(options?.method,'GET');const u=new URL(String(url));paths.push(u.pathname+u.search);
    const keys=[...u.searchParams.keys()];assert.deepEqual(keys,[...keys].sort());
    return response({items:[],nextCursor:paths.length===1?'a+b/c==':null});
  });
  assert.deepEqual(await api.history(intent.wallet,NOW),[]);
  const base=`/query/accounts/${intent.wallet}/trades`;
  assert.equal(paths[0],base+'?filter=all&limit=75');
  assert.equal(paths[1],base+'?cursor=a%2Bb%2Fc%3D%3D&filter=all&limit=75');
});
