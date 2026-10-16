// Public read-only smoke check: does not load wallet secrets or submit relayer intents.
import { Api } from './api.js';
import { Quotes, WalletStream } from './streams.js';
import { ZERO } from './types.js';
import { delay, errorText, usd } from './util.js';

const api=new Api();let quotes:Quotes|undefined,stream:WalletStream|undefined;
try {
  await api.verify();const [trading,protocol,pending]=await Promise.all([api.trading(),api.protocol(),api.pendingReward(ZERO)]);
  const market=trading.markets.find(m=>m.symbol==='BTC');if(!market)throw new Error('Missing BTC');
  quotes=new Quotes(market);stream=new WalletStream(ZERO,()=>{});quotes.start();stream.start();
  const deadline=Date.now()+20000;
  while(Date.now()<deadline&&(!stream.current||!quotes.latest))await delay(100);
  console.log(JSON.stringify({readOnly:true,build:api.build,chain:999,disabledActions:trading.disabledActions,minMarginUsdc:usd(trading.minMargin),minNotionalUsdc:usd(trading.minNotional),minimumPaperStake:usd(trading.minPaperStake),lpCashUsdc:usd(protocol.lpCash),trackedLpUsdc:usd(protocol.paper.trackedLp),queuedUsdc:usd(protocol.queue),zeroAddressPendingRewardUsdc:usd(pending),accountSse:stream.current,bbo:!!quotes.latest},null,2));
  if(!stream.current||!quotes.latest)process.exitCode=2;
}catch(e){console.error(errorText(e));process.exitCode=1;}finally{quotes?.stop();stream?.stop();}
