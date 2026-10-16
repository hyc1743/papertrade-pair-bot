import type { Store } from './store.js';
import type { Config } from './config.js';
import type { ClosedPosition, Intent, Protocol, Round } from './types.js';

export interface ExecutionTiming {roundId:number;at:number;closeMinutes:number;openMinutes:number;skewMinutes:number}
export interface CurveMinute {minute:number;rate:string}
export interface EfficiencyContext {
  closeDelayMinutes:number;closeP90Minutes:number;openDelayMinutes:number;executionSamples:number;
  rateDeclinePerMinute:number;rateTrendSamples:number;
}
export const EMPTY_EFFICIENCY_CONTEXT:EfficiencyContext={closeDelayMinutes:0.5,closeP90Minutes:0.5,openDelayMinutes:0.25,executionSamples:0,rateDeclinePerMinute:0,rateTrendSamples:0};
const percentile=(xs:number[],q:number)=>{const a=[...xs].sort((a,b)=>a-b),i=(a.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]!+(a[hi]!-a[lo]!)*(i-lo);};

/** Delays use the first signed close, including expiry/renewal wait, not just the last attempt. */
export function executionTiming(round:Round,intents:Intent[],closed:Map<string,ClosedPosition>):ExecutionTiming|null {
  if(round.state!=='complete'||!round.reason?.includes('bps')||round.legs.some(l=>!l.settled||l.settled.liquidated))return null;
  const ps=round.legs.map(l=>closed.get(`${l.wallet}:${l.settled!.id}`)??l.settled!);
  if(ps.some(p=>!p.closedAtMs||!p.openedAtMs))return null;
  const closeRequests=intents.filter(i=>i.round===round.id&&i.action==='closePositions');
  if(!round.legs.every(l=>closeRequests.some(i=>i.wallet===l.wallet)))return null;
  const at=Math.max(...ps.map(p=>p.closedAtMs!)),firstClose=Math.min(...closeRequests.map(i=>i.createdAt));
  const openMinutes=(Math.max(...ps.map(p=>p.openedAtMs!))-round.createdAt)/60000,closeMinutes=(at-firstClose)/60000;
  if(openMinutes<0||closeMinutes<0||openMinutes>1440||closeMinutes>1440)return null;
  return {roundId:round.id,at,openMinutes,closeMinutes,skewMinutes:Math.abs(ps[0]!.closedAtMs!-ps[1]!.closedAtMs!)/60000};
}
export function seedExecutionTimings(store:Store,histories:{wallet:string;positions:ClosedPosition[]}[]):number {
  const closed=new Map(histories.flatMap(h=>h.positions.map(p=>[`${h.wallet}:${p.id}`,p] as const))),intents=store.intents();
  const samples=store.rounds().flatMap(r=>{const t=executionTiming(r,intents,closed);return t?[t]:[];});
  store.transaction(()=>{
    const old=store.get<ExecutionTiming[]>('executionTimings')??[],map=new Map(old.map(x=>[x.roundId,x]));
    for(const t of samples)map.set(t.roundId,t);
    store.set('executionTimings',[...map.values()].sort((a,b)=>a.at-b.at).slice(-60));
  });
  return samples.length;
}
export function recordExecutionTiming(store:Store,round:Round):void {
  const t=executionTiming(round,store.intents(round.id),new Map());if(!t)return;
  const rows=store.get<ExecutionTiming[]>('executionTimings')??[];
  store.set('executionTimings',[...rows.filter(x=>x.roundId!==t.roundId),t].sort((a,b)=>a.at-b.at).slice(-60));
}
export function recordCurveMinute(store:Store,p:Protocol):void {
  const minute=Math.floor(p.sourceAt/60000),rows=store.get<CurveMinute[]>('curveMinutes')??[];
  if(rows.at(-1)?.minute===minute)return;
  const c=p.paper,rate=c.trackedLp<c.cliff?c.rate:c.rate*c.decay*c.decay/((c.decay+c.tail)**2n);
  store.set('curveMinutes',[...rows.filter(x=>x.minute<minute&&x.minute>=minute-360),{minute,rate:String(rate)}].slice(-360));
}
export function efficiencyContext(store:Store,config:Config,now=Date.now()):EfficiencyContext {
  const samples=(store.get<ExecutionTiming[]>('executionTimings')??[]).filter(x=>x.at<=now&&now-x.at<=7*86400000&&
    Number.isFinite(x.closeMinutes)&&x.closeMinutes>=0&&Number.isFinite(x.openMinutes)&&x.openMinutes>=0)
    .sort((a,b)=>a.at-b.at).slice(-config.executionLookbackRounds);
  const curve=(store.get<CurveMinute[]>('curveMinutes')??[]).filter(x=>x.minute<=Math.floor(now/60000)&&x.minute>=Math.floor(now/60000)-60);
  let decline=0;
  if(curve.length>=3&&curve.at(-1)!.minute-curve[0]!.minute>=5&&Math.floor(now/60000)-curve.at(-1)!.minute<=3){
    const first=Number(curve[0]!.rate),last=Number(curve.at(-1)!.rate);
    if(first>0&&last>0)decline=Math.max(0,Math.min(0.005,Math.log(first/last)/(curve.at(-1)!.minute-curve[0]!.minute)));
  }
  return {...EMPTY_EFFICIENCY_CONTEXT,...samples.length?{closeDelayMinutes:percentile(samples.map(x=>x.closeMinutes),0.5),
    closeP90Minutes:percentile(samples.map(x=>x.closeMinutes),0.9),openDelayMinutes:percentile(samples.map(x=>x.openMinutes),0.5),executionSamples:samples.length}:{},
    rateDeclinePerMinute:decline,rateTrendSamples:curve.length};
}
