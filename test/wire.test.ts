import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTrading, decodeWallet } from '../src/wire.js';
import { decodeBbo, quoteWatchdogAction, SseParser, WalletStream, walletIndexAdvances, walletIndexFresh } from '../src/streams.js';
import { market, NOW, wallet, walletFrame } from './fixtures.js';

test('SSE multiline data, comments, split CRLF and partial chunks',()=>{
  const p=new SseParser();assert.deepEqual(p.feed(': connected\r\nevent: wallet\r\nda'),[]);
  assert.deepEqual(p.feed('ta: {\r\ndata: "x": 1}\r\n\r\n'),[{event:'wallet',data:'{\n"x": 1}'}]);
  assert.deepEqual(p.feed('event: heartbeat\ndata: null\n\n'),[{event:'heartbeat',data:'null'}]);
});
test('full frame, sequential patch and reconnect requirement',()=>{
  const f=walletFrame(),d=decodeWallet(f,null,wallet().address,true);
  const patch={address:f.address,baseAccountRevision:1,accountRevision:2,state:{queueRevision:'1'},addedPositions:[],removedPositionIds:[],addedOperations:[],removedOperationIds:[]};
  assert.equal(decodeWallet(patch,d.frame,wallet().address).wallet.queueRevision,1n);
  assert.throws(()=>decodeWallet(patch,d.frame,wallet().address,true),/sync/);
  assert.throws(()=>decodeWallet({...patch,baseAccountRevision:8},d.frame,wallet().address),/sync/);
  assert.throws(()=>decodeWallet({...f,address:wallet(1).address},null,wallet().address),/identity/);
  assert.throws(()=>decodeWallet({...f,locked:'1'},null,wallet().address),/invariant/);
  assert.throws(()=>decodeWallet({...f,funds:{...f.funds,availableBalance:'1'}},null,wallet().address),/invariant/);
});
test('unknown remove, duplicate positions and negative unsigned values fail closed',()=>{
  const f=walletFrame();assert.throws(()=>decodeWallet({...f,balance:'-1'},null,wallet().address));
  const d=decodeWallet(f,null,wallet().address);
  assert.throws(()=>decodeWallet({address:f.address,baseAccountRevision:1,accountRevision:2,state:{},addedPositions:[],removedPositionIds:['99'],addedOperations:[],removedOperationIds:[]},d.frame,wallet().address),/Unknown/);
});
test('trading tuple uses disabled, not allowed, intake actions',()=>{
  const m=market();
  const frame={schemaVersion:1,indexedThroughBlock:100,tradingPaused:false,minimumTradeSizeRaw:'10',minimumOpenNotionalRaw:'10000',instruments:[[0,'BTC',0,'10',true,false,false,false,false,null,null,null,String(m.rateMultiplier),String(m.positionMultiplier),1000,String(m.maxNotional),String(m.bustBuffer),String(m.baseRate),String(m.referenceNotional),'0','0',String(m.longCap),String(m.shortCap)]],intake:[1,'0','0',['openPosition','closePositions']]};
  assert.deepEqual(decodeTrading(frame).disabledActions,['openPosition','closePositions']);
  assert.throws(()=>decodeTrading({...frame,schemaVersion:2}));
  const {intake:old,...modern}=frame;
  const current=decodeTrading({...modern,intakeControls:[1,'1000',['closePositions']]});
  assert.equal(current.maxNetOi,0n);
  assert.equal(current.minPaperStake,1000n);
  assert.deepEqual(current.disabledActions,['closePositions']);
  assert.throws(()=>decodeTrading({...frame,intakeControls:[1,'1000',[]]}),/one official intake schema/);
});
test('BBO rejects old/future/crossed prices and parses scaled integer midpoint',()=>{
  const raw={channel:'bbo',data:{coin:'BTC',time:NOW,bbo:[{px:'100000'},{px:'100000.2'}]}};
  const q=decodeBbo(raw,market(),null,NOW)!;assert.equal(q.mid,1000001n);
  assert.equal(decodeBbo({...raw,data:{...raw.data,time:NOW-6000}},market(),q,NOW),null);
  assert.equal(decodeBbo({...raw,data:{...raw.data,time:NOW+3000}},market(),q,NOW),null);
  assert.throws(()=>decodeBbo({...raw,data:{...raw.data,bbo:[{px:'100000.2'},{px:'100000'}]}},market(),null,NOW),/Invalid BBO/);
});
test('quote watchdog refreshes a quiet BBO before reconnecting a still-open but stale WebSocket',()=>{
  const start=1_000_000;
  assert.equal(quoteWatchdogAction(start+6000,start,0,start),'ok');
  assert.equal(quoteWatchdogAction(start+7000,start,0,start),'refresh');
  assert.equal(quoteWatchdogAction(start+10000,start,start+7000,start),'ok');
  assert.equal(quoteWatchdogAction(start+14000,start,start+7000,start),'ok');
  assert.equal(quoteWatchdogAction(start+15000,start,start+7000,start),'reconnect');
  assert.equal(quoteWatchdogAction(start+46000,start+45000,0,start),'reconnect');
});
test('wallet SSE heartbeat cannot make an old account index current',()=>{
  assert.equal(walletIndexFresh(Math.floor(NOW/1000)-10,NOW),true);
  assert.equal(walletIndexFresh(Math.floor(NOW/1000)-31,NOW),false);
  assert.equal(walletIndexFresh(Math.floor(NOW/1000)+6,NOW),false);
  const previous=wallet();
  assert.equal(walletIndexAdvances(previous,{...previous,block:99,timestamp:previous.timestamp+1}),false);
  assert.equal(walletIndexAdvances(previous,{...previous,block:100,timestamp:previous.timestamp+1}),true);
  assert.equal(walletIndexAdvances(previous,{...previous,block:100,timestamp:previous.timestamp-1}),false);
});
test('wallet stream abandons a silent stale index even when its response body ignores abort',async()=>{
  const frame={...walletFrame(),indexedThroughTimestamp:Math.floor(Date.now()/1000)-29};
  const encoder=new TextEncoder();let calls=0;
  const fetcher=(async()=>{
    calls++;
    return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encoder.encode(`event: wallet\ndata: ${JSON.stringify(frame)}\n\n`));}}),
      {headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const stream=new WalletStream(wallet().address,()=>{},fetcher);
  try {
    stream.start();
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(stream.current,true);
    await new Promise(resolve=>setTimeout(resolve,2200));
    assert.equal(stream.current,false);
    assert(calls>=2,'stale index must trigger a new SSE request');
  }finally{stream.stop();}
});
