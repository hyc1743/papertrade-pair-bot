import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { concatHex, hashTypedData, keccak256, parseSignature, toBytes, type Address, type Hex, type TypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CHAIN_ID, EXCHANGE, PAPER_STAKING, ZERO, type PrimaryType, type Signed } from './types.js';

export const TYPES = {
  RegisterSessionKey:[{name:'user',type:'address'},{name:'key',type:'address'},{name:'expiry',type:'uint64'},{name:'feeAddress',type:'address'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint64'}],
  OpenPosition:[{name:'user',type:'address'},{name:'instrumentId',type:'uint32'},{name:'isLong',type:'bool'},{name:'size',type:'uint128'},{name:'leverage',type:'uint32'},{name:'useDebt',type:'bool'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint64'}],
  Close:[{name:'user',type:'address'},{name:'positionIds',type:'uint256[]'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint64'}],
  CancelIntent:[{name:'user',type:'address'},{name:'intentId',type:'bytes32'},{name:'deadline',type:'uint256'}],
  Stake:[{name:'user',type:'address'},{name:'amount',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint64'}],
  Claim:[{name:'user',type:'address'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint64'}]
} as const;
export const domain = (type:PrimaryType) => ({ name:type==='CancelIntent'?'PaperTrade Intent Cancel':type==='Stake'||type==='Claim'?'PaperStaking':'String',version:type==='CancelIntent'?'2':'1',chainId:CHAIN_ID,verifyingContract:type==='Stake'||type==='Claim'?PAPER_STAKING:EXCHANGE });
const ID_PREFIX=keccak256(toBytes('papertrade:intent-id:v2'));
export interface Identity { address:Address; master:PrivateKeyAccount; privateKey:Hex }
export interface Session { privateKey:Hex; address:Address; expiry:number }
export function loadIdentities(env:NodeJS.ProcessEnv=process.env):[Identity,Identity] {
  const accounts=['A','B'].map(side=>{
    const value=env[`PAPERTRADE_WALLET_${side}_PRIVATE_KEY`]?.trim();
    if(!value || !/^(0x)?[0-9a-fA-F]{64}$/.test(value)) throw new Error(`PAPERTRADE_WALLET_${side}_PRIVATE_KEY 缺失或格式无效`);
    const privateKey=(`0x${value.replace(/^0x/,'')}`) as Hex;
    let master:PrivateKeyAccount;
    try { master=privateKeyToAccount(privateKey); } catch { throw new Error(`钱包 ${side} 私钥无效`); }
    return {privateKey,master,address:master.address.toLowerCase() as Address};
  }) as [Identity,Identity];
  if(accounts[0].address===accounts[1].address) throw new Error('两个钱包必须不同');
  return accounts;
}
export function newSession(now=Date.now()):Session {
  const privateKey=generatePrivateKey();
  return {privateKey,address:privateKeyToAccount(privateKey).address.toLowerCase() as Address,expiry:Math.floor(now/1000)+30*86400};
}
export async function signIntent(account:PrivateKeyAccount,type:PrimaryType,message:Record<string,unknown>):Promise<{signed:Signed;id:Hex}> {
  if(typeof message.user!=='string' || !/^0x[0-9a-fA-F]{40}$/.test(message.user)) throw new Error('Invalid intent user');
  if(type==='OpenPosition' && message.useDebt!==false) throw new Error('Debt-funded opens are disabled');
  if(type==='RegisterSessionKey' && (message.user.toLowerCase()!==account.address.toLowerCase() || message.feeAddress!==ZERO)) throw new Error('Invalid session registration identity');
  if((type==='Stake'||type==='Claim')&&message.user.toLowerCase()!==account.address.toLowerCase())throw new Error('PAPER rewards require the real wallet signer');
  if(type==='Stake'&&BigInt(String(message.amount))<=0n)throw new Error('Stake amount must be positive');
  const types:{[key:string]:TypedData[string]}={ [type]:TYPES[type] };
  const typed={domain:domain(type),types,primaryType:type,message};
  const signature=await account.signTypedData(typed);
  const digest=hashTypedData(typed);
  const p=parseSignature(signature);
  const signed:Signed={};
  for(const field of TYPES[type]) {
    const value=message[field.name];
    signed[field.name]=field.type==='uint256[]'?(value as bigint[]).map(String):field.type.startsWith('uint')?String(value):field.type==='bool'?value as boolean:String(value).toLowerCase();
  }
  signed.v=String(27+Number(p.yParity)); signed.r=p.r.toLowerCase(); signed.s=p.s.toLowerCase();
  return {signed,id:keccak256(concatHex([ID_PREFIX,digest,account.address.toLowerCase() as Address]))};
}
function encryptionKey(identity:Identity,salt:Buffer):Buffer {
  return Buffer.from(hkdfSync('sha256',Buffer.from(identity.privateKey.slice(2),'hex'),salt,`papertrade-session:v1:${CHAIN_ID}:${EXCHANGE}:${identity.address}`,32));
}
export function encryptSession(session:Session,identity:Identity):string {
  const salt=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(identity,salt),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(session)),cipher.final()]);
  return JSON.stringify({version:1,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
}
export function decryptSession(text:string,identity:Identity):Session {
  try {
    const e=JSON.parse(text);
    if(e.version!==1) throw new Error();
    const decipher=createDecipheriv('aes-256-gcm',encryptionKey(identity,Buffer.from(e.salt,'base64')),Buffer.from(e.iv,'base64'));
    decipher.setAuthTag(Buffer.from(e.tag,'base64'));
    const s=JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.data,'base64')),decipher.final()]).toString()) as Session;
    if(!Number.isSafeInteger(s.expiry) || privateKeyToAccount(s.privateKey).address.toLowerCase()!==s.address) throw new Error();
    return s;
  } catch { throw new Error('Session 缓存解密或身份校验失败；保留状态文件并检查钱包配置'); }
}
