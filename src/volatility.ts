export interface MinutePrice { minute:number; mid:string }
export interface VolatilityEstimate {
  sigmaBpsPerSqrtMinute:number;
  returnSamples:number;
  observedMinutes:number;
  latestMinute:number;
  sigma5Bps?:number|null;
  sigma15Bps?:number|null;
  range15Bps?:number|null;
  trendEfficiency15?:number;
  signedReturn15Bps?:number;
}

/** One-minute BBO mid closes; gaps are never mistaken for one-minute returns. */
export class PriceVolatility {
  private samples:MinutePrice[];
  private current:MinutePrice|null=null;
  constructor(saved:MinutePrice[]=[]) {
    this.samples=saved.filter(x=>Number.isSafeInteger(x.minute)&&x.minute>=0&&/^\d+$/.test(x.mid)&&BigInt(x.mid)>0n)
      .sort((a,b)=>a.minute-b.minute).filter((x,i,a)=>i===0||x.minute!==a[i-1]!.minute).slice(-120);
  }
  observe(mid:bigint,at:number):boolean {
    if(mid<=0n||!Number.isFinite(at))return false;
    const minute=Math.floor(at/60000),next={minute,mid:String(mid)};
    if(this.current===null){this.current=next;return false;}
    if(minute<this.current.minute)return false;
    if(minute===this.current.minute){this.current=next;return false;}
    this.samples.push(this.current);this.samples=this.samples.filter(x=>x.minute>=minute-120).slice(-120);
    this.current=next;return true;
  }
  export():MinutePrice[] {return [...this.samples];}
  estimate(now:number):VolatilityEstimate|null {
    const currentMinute=Math.floor(now/60000),rows=this.samples.filter(x=>x.minute>=currentMinute-60&&x.minute<=currentMinute);
    if(rows.length<11||currentMinute-rows.at(-1)!.minute>3)return null;
    let squares=0,count=0;
    for(let i=1;i<rows.length;i++) {
      if(rows[i]!.minute-rows[i-1]!.minute!==1)continue;
      const a=Number(rows[i-1]!.mid),b=Number(rows[i]!.mid);
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<=0||b<=0)continue;
      const move=Math.log(b/a)*10000;
      squares+=move*move;count++;
    }
    if(count<10)return null;
    const window=(minutes:number)=>{
      const rs=rows.filter(x=>x.minute>=currentMinute-minutes),returns:number[]=[];
      for(let i=1;i<rs.length;i++)if(rs[i]!.minute-rs[i-1]!.minute===1)returns.push(Math.log(Number(rs[i]!.mid)/Number(rs[i-1]!.mid))*10000);
      const prices=rs.map(x=>Number(x.mid)),total=returns.reduce((s,r)=>s+Math.abs(r),0);
      const net=returns.reduce((s,r)=>s+r,0),enough=returns.length>=Math.min(3,minutes-1);
      return {sigma:enough?Math.sqrt(returns.reduce((s,r)=>s+r*r,0)/returns.length):null,
        range:enough?Math.log(Math.max(...prices)/Math.min(...prices))*10000:null,
        efficiency:total>0?Math.min(1,Math.abs(net)/total):0,net};
    };
    const fast=window(5),medium=window(15);
    return {sigmaBpsPerSqrtMinute:Math.sqrt(squares/count),returnSamples:count,observedMinutes:rows.at(-1)!.minute-rows[0]!.minute,latestMinute:rows.at(-1)!.minute,
      sigma5Bps:fast.sigma,sigma15Bps:medium.sigma,range15Bps:medium.range,trendEfficiency15:medium.efficiency,signedReturn15Bps:medium.net};
  }
}
export function expectedHitMinutes(bps:number,vol:VolatilityEstimate,currentMoveBps=0):number {
  const sigma=vol.sigmaBpsPerSqrtMinute;
  return sigma>0?Math.max(0,bps*bps-currentMoveBps*currentMoveBps)/(sigma*sigma):Infinity;
}
