import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address } from 'viem';
import { configSchema } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { delay } from '../src/util.js';
import type { TradingApi } from '../src/api.js';
import type { WalletSource } from '../src/streams.js';
import { identities, protocol, trading, wallet } from './fixtures.js';

test('independent 1-second LP reader proceeds while market HTTP waits; no overlapping LP requests',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'papertrade-poll-')),store=new Store(dir),ids=identities();
  const sources=new Map<Address,WalletSource>(ids.map((id,i)=>[id.address,{latest:wallet(i),current:true,start(){},stop(){}}]));
  const times:number[]=[];let active=0,maximum=0,firstMarketFinished=0;
  const api:TradingApi={
    trading:async()=>{await delay(1400);firstMarketFinished ||= Date.now();return trading();},
    protocol:async(signal)=>{times.push(Date.now());active++;maximum=Math.max(maximum,active);try{await delay(10,signal);return {...protocol(),block:100+times.length,sourceAt:Date.now()};}finally{active--;}} ,
    pendingReward:async()=>0n,history:async()=>[],cancel:async()=> 'pending',submit:async()=>{throw new Error('Unexpected financial request');}
  };
  const config=configSchema.parse({marginUsdc:'200',leverage:50,keepRewardsMonitoring:true,lpPollIntervalMs:1000,stateDir:dir});
  const engine=new Engine(config,ids,store,api,{sources,rewardsOnly:true});
  const stop=setTimeout(()=>engine.requestStop(),2300);
  try {await engine.run();assert(times.length>=2);assert(times[1]!<firstMarketFinished);assert.equal(maximum,1);assert.equal(active,0);}
  finally{clearTimeout(stop);store.close();rmSync(dir,{recursive:true,force:true});}
});
