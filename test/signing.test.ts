import test from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, hashTypedData, keccak256, recoverTypedDataAddress, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decryptSession, domain, encryptSession, loadIdentities, newSession, signIntent, TYPES } from '../src/signing.js';
import { EXCHANGE, PAPER_STAKING, ZERO } from '../src/types.js';
import { identities, NOW } from './fixtures.js';

test('private keys remain local and duplicate/invalid keys are refused',()=>{
  assert.equal(identities().length,2);
  assert.throws(()=>loadIdentities({}),/缺失/);
  assert.throws(()=>loadIdentities({PAPERTRADE_WALLET_A_PRIVATE_KEY:'0'.repeat(64),PAPERTRADE_WALLET_B_PRIVATE_KEY:'2'.padStart(64,'0')}),/私钥无效/);
  assert.throws(()=>loadIdentities({PAPERTRADE_WALLET_A_PRIVATE_KEY:'1'.padStart(64,'0'),PAPERTRADE_WALLET_B_PRIVATE_KEY:'1'.padStart(64,'0')}),/必须不同/);
});
test('official typed signature and intent ID use the session signer, not the owner',async()=>{
  const owner=identities()[0],session=newSession(NOW),account=privateKeyToAccount(session.privateKey);
  const message={user:owner.address,instrumentId:0,isLong:true,size:500n*10n**18n,leverage:20,useDebt:false,nonce:123n,deadline:BigInt(NOW/1000+3600)};
  const signed=await signIntent(account,'OpenPosition',message);
  const typed={domain:domain('OpenPosition'),types:{OpenPosition:TYPES.OpenPosition},primaryType:'OpenPosition' as const,message};
  const signature=concatHex([signed.signed.r as `0x${string}`,signed.signed.s as `0x${string}`,`0x${Number(signed.signed.v).toString(16)}`]);
  const recovered=await recoverTypedDataAddress({...typed,signature});assert.equal(recovered.toLowerCase(),session.address);
  assert.equal(signed.id,keccak256(concatHex([keccak256(toBytes('papertrade:intent-id:v2')),hashTypedData(typed),session.address])));
  assert.equal(signed.signed.size,'500000000000000000000');assert.equal(signed.signed.useDebt,false);
  await assert.rejects(signIntent(account,'OpenPosition',{...message,useDebt:true}),/Debt/);
});
test('registration can only be signed by the master and preserves zero fee recipient',async()=>{
  const owner=identities()[0],session=newSession(NOW);
  const m={user:owner.address,key:session.address,expiry:BigInt(session.expiry),feeAddress:ZERO,nonce:1n,deadline:BigInt(NOW/1000+3600)};
  assert((await signIntent(owner.master,'RegisterSessionKey',m)).signed.r);
  await assert.rejects(signIntent(privateKeyToAccount(session.privateKey),'RegisterSessionKey',m),/identity/);
});
test('session cache uses authenticated per-wallet encryption',()=>{
  const owner=identities()[0],s=newSession(NOW),encrypted=encryptSession(s,owner);
  assert(!encrypted.includes(s.privateKey));assert.deepEqual(decryptSession(encrypted,owner),s);
  assert.throws(()=>decryptSession(encrypted,identities()[1]),/解密/);
  const e=JSON.parse(encrypted);e.tag=Buffer.alloc(16).toString('base64');
  assert.throws(()=>decryptSession(JSON.stringify(e),owner),/解密/);
});
test('staking/claim signatures use PaperStaking domain and require master wallet identity',async()=>{
  const owner=identities()[0],session=newSession(NOW);
  const m={user:owner.address,amount:2450n*10n**18n,nonce:9n,deadline:BigInt(NOW/1000+3600)};
  const s=await signIntent(owner.master,'Stake',m);assert.equal(s.signed.amount,'2450000000000000000000');
  assert.equal(domain('Stake').verifyingContract,PAPER_STAKING);assert.notEqual(domain('Stake').verifyingContract,EXCHANGE);
  await assert.rejects(signIntent(privateKeyToAccount(session.privateKey),'Stake',m),/real wallet/);
  await assert.rejects(signIntent(privateKeyToAccount(session.privateKey),'Claim',{user:owner.address,nonce:10n,deadline:m.deadline}),/real wallet/);
  assert((await signIntent(owner.master,'Claim',{user:owner.address,nonce:10n,deadline:m.deadline})).signed.r);
});
