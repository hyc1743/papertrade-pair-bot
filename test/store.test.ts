import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, Store } from '../src/store.js';
import { identities, position } from './fixtures.js';
import { amount, errorText, redact } from '../src/util.js';

test('persistent nonce, private permissions, identity lock and transaction rollback',()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-store-'));const ids=identities();let s=new Store(dir);
  try {
    s.bind(ids.map(i=>i.address),'BTC');const n=s.nonce(ids[0].address);s.close();s=new Store(dir);assert.equal(s.nonce(ids[0].address),n+1n);
    assert.equal(statSync(s.path).mode&0o777,0o600);
    assert.throws(()=>s.bind([ids[1].address,ids[0].address],'BTC'),/不匹配/);
    assert.throws(()=>s.transaction(()=>{s.set('temporary',1);throw new Error('abort');}));assert.equal(s.get('temporary'),null);
    const raw=readFileSync(s.path).toString('latin1');assert(!raw.includes(ids[0].privateKey));
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('settlements are exactly once and changed settlement values cannot silently replace history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-ledger-'));const s=new Store(dir);
  try {
    const p={...position(),liquidated:false,netPnl:-amount('100'),paper:amount('9800')};s.record(identities()[0].address,1,p);s.record(identities()[0].address,1,p);
    assert.equal(s.totals().positions,1);assert.equal(s.totals().netPnl,-amount('100'));
    assert.throws(()=>s.record(identities()[0].address,1,{...p,netPnl:0n}),/不一致/);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('run lock refuses a concurrent process',()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-lock-')),release=acquireLock(dir);
  try {assert.throws(()=>acquireLock(dir),/并发/);}finally{release();rmSync(dir,{recursive:true,force:true});}
});
test('logs hide signed payloads and long secret hex strings',()=>{
  const key='0x'+'f'.repeat(64);assert.equal(errorText(new Error('bad '+key)),'bad [redacted]');
  assert.deepEqual(redact({privateKey:key,signed:{r:key},wallet:identities()[0].address}),{privateKey:'[redacted]',signed:'[redacted]',wallet:identities()[0].address});
});
test('paper and exchange nonce namespaces advance independently and survive reopening',()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-nonce-')),a=identities()[0].address;let s=new Store(dir);
  try {const exchange=s.nonce(a),paper=s.nonce(a,'paper');s.close();s=new Store(dir);assert.equal(s.nonce(a),exchange+1n);assert.equal(s.nonce(a,'paper'),paper+1n);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
