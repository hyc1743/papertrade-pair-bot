import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync, lstatSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import type { ClosedPosition, Intent, IntentState, Round, Wallet } from './types.js';
import { fromJson, json } from './util.js';

export class Store {
  readonly db:DatabaseSync;
  readonly path:string;
  constructor(readonly dir:string,readonly readOnly=false) {
    this.path=join(dir,'state.db');
    if(!readOnly) { mkdirSync(dir,{recursive:true,mode:0o700}); if(lstatSync(dir).isSymbolicLink()) throw new Error('状态目录不能是符号链接'); chmodSync(dir,0o700); }
    if(existsSync(this.path)&&lstatSync(this.path).isSymbolicLink()) throw new Error('状态文件不能是符号链接');
    this.db=new DatabaseSync(this.path,{readOnly});
    this.db.exec('PRAGMA busy_timeout=5000');
    if(!readOnly) {
      chmodSync(this.path,0o600);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY,wallet TEXT NOT NULL,round_id INTEGER,action TEXT NOT NULL,state TEXT NOT NULL,deadline INTEGER NOT NULL,created_at INTEGER NOT NULL,ack_revision TEXT,signed TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT,state TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settlements (wallet TEXT NOT NULL,position_id TEXT NOT NULL,round_id INTEGER NOT NULL,net_pnl TEXT NOT NULL,paper TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(wallet,position_id));
        CREATE TABLE IF NOT EXISTS snapshots (wallet TEXT PRIMARY KEY,data TEXT NOT NULL);
      `);
      const version=this.get<number>('schemaVersion');
      if(version!==null&&version!==1) throw new Error('不支持的状态数据库版本');
      this.set('schemaVersion',1);
    }
  }
  static exists(dir:string) { return existsSync(join(dir,'state.db')); }
  close() { this.db.close(); }
  get<T>(key:string):T|null {
    const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined;
    return row?fromJson<T>(row.value):null;
  }
  set(key:string,value:unknown) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,json(value)); }
  transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  bind(addresses:Address[],market:string) {
    const id=`${addresses.join(':')}:${market}`;
    const old=this.get<string>('identity');
    if(old && old!==id) throw new Error('钱包/市场与历史状态不匹配；不要用新钱包覆盖旧仓位状态');
    this.set('identity',id); this.set('addresses',addresses); this.set('market',market);
  }
  nonce(wallet:Address,namespace:'exchange'|'paper'='exchange'):bigint {
    return this.transaction(()=>{
      const key=namespace==='exchange'?`nonce:${wallet}`:`nonce:paper:${wallet}`;
      const next=this.get<string>(key);
      const n=next===null?BigInt(randomBytes(3).readUIntBE(0,3)||1)*256n:BigInt(next);
      this.set(key,String(n+1n)); return n;
    });
  }
  prepare(i:Intent) {
    this.db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)').run(i.id,i.wallet,i.round,i.action,i.state,i.deadline,i.createdAt,i.ackRevision,json(i.signed));
  }
  intent(id:Hex):Intent|null {
    const row=this.db.prepare('SELECT * FROM intents WHERE id=?').get(id);
    return row?this.parseIntent(row):null;
  }
  intents(round?:number):Intent[] {
    const rows=round===undefined?this.db.prepare('SELECT * FROM intents ORDER BY created_at').all():this.db.prepare('SELECT * FROM intents WHERE round_id=? ORDER BY created_at').all(round);
    return rows.map(row=>this.parseIntent(row));
  }
  private parseIntent(row:Record<string,unknown>):Intent {
    return {id:row.id as Hex,wallet:row.wallet as Address,round:row.round_id as number|null,action:row.action as Intent['action'],state:row.state as IntentState,deadline:row.deadline as number,createdAt:row.created_at as number,ackRevision:row.ack_revision as string|null,signed:fromJson(row.signed as string)};
  }
  updateIntent(id:Hex,state:IntentState,revision?:bigint) {
    this.db.prepare('UPDATE intents SET state=?,ack_revision=COALESCE(?,ack_revision) WHERE id=?').run(state,revision===undefined?null:String(revision),id);
  }
  nextRoundId():number { return Number((this.db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM rounds').get() as {n:number}).n); }
  saveRound(round:Round) { this.db.prepare('INSERT INTO rounds VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(round.id,round.state,json(round)); }
  activeRound():Round|null {
    const row=this.db.prepare("SELECT data FROM rounds WHERE state!='complete' ORDER BY id DESC LIMIT 1").get() as {data:string}|undefined;
    return row?fromJson<Round>(row.data):null;
  }
  rounds():Round[] { return (this.db.prepare('SELECT data FROM rounds ORDER BY id').all() as {data:string}[]).map(r=>fromJson<Round>(r.data)); }
  record(wallet:Address,round:number,p:ClosedPosition) {
    const previous=this.settlement(wallet,p.id);
    if(previous && (previous.netPnl!==p.netPnl || previous.paper!==p.paper || previous.liquidated!==p.liquidated)) throw new Error('历史结算与已记录结算不一致');
    this.db.prepare('INSERT OR IGNORE INTO settlements VALUES (?,?,?,?,?,?)').run(wallet,p.id,round,String(p.netPnl),String(p.paper),json(p));
  }
  settlement(wallet:Address,id:string):ClosedPosition|null {
    const row=this.db.prepare('SELECT data FROM settlements WHERE wallet=? AND position_id=?').get(wallet,id) as {data:string}|undefined;
    return row?fromJson<ClosedPosition>(row.data):null;
  }
  totals() {
    const rows=this.db.prepare('SELECT net_pnl,paper FROM settlements').all() as {net_pnl:string;paper:string}[];
    return {netPnl:rows.reduce((s,r)=>s+BigInt(r.net_pnl),0n),paper:rows.reduce((s,r)=>s+BigInt(r.paper),0n),positions:rows.length,rounds:Number((this.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE state='complete'").get() as {n:number}).n)};
  }
  snapshot(w:Wallet) { this.db.prepare('INSERT INTO snapshots VALUES (?,?) ON CONFLICT(wallet) DO UPDATE SET data=excluded.data').run(w.address,json({...w,closed:[],outcomes:[]})); }
  snapshots():Wallet[] { return (this.db.prepare('SELECT data FROM snapshots').all() as {data:string}[]).map(r=>fromJson<Wallet>(r.data)); }
}

export function acquireLock(dir:string):()=>void {
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path=join(dir,'run.lock');
  const token=randomBytes(16).toString('hex');
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const fd=openSync(path,'wx',0o600); writeSync(fd,JSON.stringify({pid:process.pid,token})); closeSync(fd);
      return ()=>{ try { const current=JSON.parse(readFileSync(path,'utf8')); if(current.token===token) unlinkSync(path); } catch {} };
    } catch(e) {
      if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e;
      // Serialize stale-lock recovery. Without this, two cleaners can delete each other's new lock.
      const recovery=join(dir,'recover-lock');
      try {mkdirSync(recovery,{mode:0o700});}catch{throw new Error('另一个进程正在恢复锁；若长期存在，请检查 recover-lock');}
      try {
        if(!existsSync(path))continue;
        let pid:number;
        try {pid=JSON.parse(readFileSync(path,'utf8')).pid;if(!Number.isInteger(pid)||pid<=0)throw new Error();}
        catch{throw new Error('锁文件无效；确认没有运行中的机器人后手动移除 run.lock');}
        try {process.kill(pid,0);throw new Error(`已有机器人进程 ${pid}，拒绝并发启动`);}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;unlinkSync(path);}
      }finally{rmdirSync(recovery);}
    }
  }
  throw new Error('无法获取机器人进程锁');
}
