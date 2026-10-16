import WebSocket from 'ws';
import { z } from 'zod';
import type { Address } from 'viem';
import { HL_WS, ORIGIN, type Market, type Quote, type Wallet, WAD } from './types.js';
import { amount, delay, errorText, log } from './util.js';
import { decodeWallet, type WalletFrame } from './wire.js';

export interface SseEvent { event:string; data:string }
export class SseParser {
  private buffer=''; private event='message'; private data:string[]=[];
  feed(chunk:string):SseEvent[] {
    this.buffer+=chunk; if(this.buffer.length>2_000_000) throw new Error('SSE frame too large');
    const events:SseEvent[]=[];
    for(;;) {
      const p=this.buffer.indexOf('\n'); if(p<0) break;
      const line=this.buffer.slice(0,p).replace(/\r$/,'');this.buffer=this.buffer.slice(p+1);
      if(line==='') { if(this.data.length) events.push({event:this.event,data:this.data.join('\n')});this.event='message';this.data=[]; }
      else if(!line.startsWith(':')) {
        const sep=line.indexOf(':'),field=sep<0?line:line.slice(0,sep),value=sep<0?'':line.slice(sep+1).replace(/^ /,'');
        if(field==='event') this.event=value; if(field==='data') this.data.push(value);
        if(this.data.join('\n').length>2_000_000) throw new Error('SSE event too large');
      }
    }
    return events;
  }
}
export interface WalletSource { latest:Wallet|null; current:boolean; start():void; stop():void }
/** An SSE heartbeat only proves the connection is alive, not that its index advances. */
export function walletIndexFresh(indexedThroughTimestamp:number,now=Date.now(),maxAgeMs=30000):boolean {
  const age=now-indexedThroughTimestamp*1000;
  return Number.isSafeInteger(indexedThroughTimestamp)&&age>=-5000&&age<=maxAgeMs;
}
export function walletIndexAdvances(previous:Wallet|null,next:Wallet):boolean {
  return !previous||next.block>previous.block||next.block===previous.block&&next.timestamp>=previous.timestamp;
}
export class WalletStream implements WalletSource {
  latest:Wallet|null=null; private connected=false;
  get current():boolean {return this.connected&&!!this.latest&&walletIndexFresh(this.latest.timestamp);}
  private abort=new AbortController(); private started=false; private frame:WalletFrame|null=null;
  constructor(readonly address:Address,private observe:(w:Wallet)=>void,private fetcher:typeof fetch=fetch) {}
  start() { if(this.started)return;this.started=true;void this.loop(); }
  stop() { this.abort.abort();this.connected=false; }
  private async loop() {
    let failures=0;
    while(!this.abort.signal.aborted) {
      this.connected=false; let timer:NodeJS.Timeout|undefined,staleIndex=false;
      const conn=new AbortController(),signal=AbortSignal.any([this.abort.signal,conn.signal]);
      let activity=Date.now(),timeout=15000,requireFull=true;
      try {
        timer=setInterval(()=>{
          if(!requireFull&&this.latest&&!walletIndexFresh(this.latest.timestamp)){staleIndex=true;conn.abort(new Error('Account index stale'));}
          else if(Date.now()-activity>timeout)conn.abort(new Error('Account stream silence'));
        },1000);
        const r=await this.fetcher(`${ORIGIN}/state/user/live?wallet=${this.address}`,{headers:{accept:'text/event-stream','user-agent':'Mozilla/5.0'},signal,redirect:'error',cache:'no-store'});
        if(!r.ok||!r.body||!r.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Account SSE unavailable');
        const parser=new SseParser(),decoder=new TextDecoder();let silence=30000;
        const reader=r.body.getReader();
        let onAbort:()=>void=()=>{};
        const aborted=new Promise<never>((_,reject)=>{
          onAbort=()=>reject(signal.reason??new Error('Account stream interrupted'));
          if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});
        });
        try {for(;;) {
          // Undici can leave an async stream iterator pending after abort. Race
          // the read explicitly so stale-index reconnect cannot get stuck.
          const {value:chunk,done}=await Promise.race([reader.read(),aborted]);
          if(done)break;
          for(const e of parser.feed(decoder.decode(chunk,{stream:true}))) {
            if(e.event==='liveness') {
              const value=z.object({heartbeatIntervalMs:z.number().int().positive().max(60000)}).parse(JSON.parse(e.data));
              silence=Math.min(45000,value.heartbeatIntervalMs*3);
            } else if(e.event==='heartbeat') {
              if(JSON.parse(e.data)!==null)throw new Error('Invalid SSE heartbeat');activity=Date.now();
            } else if(e.event==='wallet') {
              const raw=JSON.parse(e.data),decoded=decodeWallet(raw,this.frame,this.address,requireFull);
              if(!walletIndexFresh(decoded.wallet.timestamp)){staleIndex=true;throw new Error('Account index stale');}
              if(!walletIndexAdvances(this.latest,decoded.wallet))throw new Error('Account index regressed');
              if(!requireFull&&this.frame) {
                if(decoded.wallet.revision<this.frame.accountRevision)throw new Error('Account revision regressed');
                if(decoded.wallet.revision===this.frame.accountRevision&&decoded.wallet.block<=this.frame.indexedThroughBlock){activity=Date.now();continue;}
              }
              this.observe(decoded.wallet); // Consumer persistence must succeed before claiming the stream is current.
              this.frame=decoded.frame;this.latest=decoded.wallet;this.connected=true;requireFull=false;failures=0;activity=Date.now();timeout=silence;
            }
          }
        }} finally {signal.removeEventListener('abort',onAbort);void reader.cancel().catch(()=>{});}
        throw new Error('Account SSE ended');
      } catch(e) {
        if(!this.abort.signal.aborted)log('wallet_stream_reconnecting',{wallet:this.address,error:errorText(e)});
      } finally {if(timer)clearInterval(timer);conn.abort();this.connected=false;}
      // A stale edge is not a service outage. Try another edge promptly rather
      // than exponential-backoff past the active-position data grace window.
      if(!this.abort.signal.aborted) { try {await delay(staleIndex?500:Math.min(30000,1000*2**Math.min(failures++,5)),this.abort.signal);}catch{} }
    }
  }
}

export interface QuoteSource { latest:Quote|null; start():void; stop():void; diagnostics?():{connected:boolean;lastBboAt:number|null;lastMessageAt:number|null;refreshes:number} }
const bboSchema=z.object({channel:z.literal('bbo'),data:z.object({coin:z.string(),time:z.number().int().nonnegative(),bbo:z.tuple([z.object({px:z.string()}),z.object({px:z.string()})])})});
export function decodeBbo(input:unknown,m:Market,previous:Quote|null,now=Date.now()):Quote|null {
  const f=bboSchema.parse(input);
  if(f.data.coin!==m.symbol||f.data.time>now+2000||f.data.time<now-5000||previous&&f.data.time<previous.time)return null;
  const bid=amount(f.data.bbo[0].px)*m.priceScale/WAD,ask=amount(f.data.bbo[1].px)*m.priceScale/WAD;
  if(bid<=0n||ask<bid)throw new Error('Invalid BBO');
  return {bid,ask,mid:(bid+ask)/2n,time:f.data.time,receivedAt:now};
}
export function quoteWatchdogAction(now:number,lastBboAt:number,lastRefreshAt:number,lastMessageAt:number):'ok'|'refresh'|'reconnect' {
  if(now-lastBboAt>=15000||now-lastMessageAt>=45000)return 'reconnect';
  if(now-lastBboAt>=7000&&lastRefreshAt<lastBboAt)return 'refresh';
  return 'ok';
}
export class Quotes implements QuoteSource {
  latest:Quote|null=null; private ws:WebSocket|null=null; private stopped=false;
  private retry:NodeJS.Timeout|undefined; private heartbeat:NodeJS.Timeout|undefined; private failures=0;
  private lastBboAt:number|null=null; private lastMessageAt:number|null=null; private refreshes=0;
  constructor(readonly market:Market) {}
  diagnostics() {return {connected:this.ws?.readyState===WebSocket.OPEN,lastBboAt:this.lastBboAt,lastMessageAt:this.lastMessageAt,refreshes:this.refreshes};}
  start() {
    if(this.stopped||this.ws)return;
    const ws=new WebSocket(HL_WS,{handshakeTimeout:15000});this.ws=ws;let activity=Date.now(),lastBbo=activity,lastRefresh=0,lastPing=0;
    ws.on('open',()=>{
      activity=Date.now();lastBbo=activity;this.lastMessageAt=activity;
      this.failures=0;ws.send(JSON.stringify({method:'subscribe',subscription:{type:'bbo',coin:this.market.symbol}}));
      this.heartbeat=setInterval(()=>{
        if(ws.readyState!==WebSocket.OPEN)return;
        const now=Date.now(),action=quoteWatchdogAction(now,lastBbo,lastRefresh,activity);
        if(action==='reconnect') {log('quote_stale_reconnect',{market:this.market.symbol,bboAgeMs:now-lastBbo,messageAgeMs:now-activity});ws.terminate();return;}
        if(action==='refresh') {
          lastRefresh=now;this.refreshes++;
          log('quote_resubscribe',{market:this.market.symbol,bboAgeMs:now-lastBbo});
          const subscription={type:'bbo',coin:this.market.symbol};
          ws.send(JSON.stringify({method:'unsubscribe',subscription}));ws.send(JSON.stringify({method:'subscribe',subscription}));
        }
        if(now-lastPing>=20000){lastPing=now;ws.send(JSON.stringify({method:'ping'}));}
      },1000);
    });
    ws.on('message',raw=>{
      try {const data=JSON.parse(raw.toString());activity=Date.now();this.lastMessageAt=activity;if(data.channel!=='bbo')return;const q=decodeBbo(data,this.market,this.latest);if(q){this.latest=q;lastBbo=activity;this.lastBboAt=activity;}} catch(e) {log('quote_invalid',{error:errorText(e)});}
    });
    ws.on('error',()=>{if(!this.stopped)log('quote_socket_error',{market:this.market.symbol});});
    ws.on('close',code=>{
      if(this.heartbeat)clearInterval(this.heartbeat);this.heartbeat=undefined;this.ws=null;this.latest=null;
      if(!this.stopped)log('quote_disconnected',{market:this.market.symbol,code});
      if(!this.stopped)this.retry=setTimeout(()=>this.start(),Math.min(30000,1000*2**Math.min(this.failures++,5)));
    });
  }
  stop() {this.stopped=true;if(this.retry)clearTimeout(this.retry);if(this.heartbeat)clearInterval(this.heartbeat);this.ws?.terminate();this.latest=null;}
}
