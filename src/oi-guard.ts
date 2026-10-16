/** Counts distinct, consecutive safe trading snapshots before admitting a paired open. */
export class OiStabilityGate {
  private lastBlock=-1;
  private count=0;
  private firstAt=0;
  observe(block:number,safe:boolean,now:number,required:number,minMs:number) {
    if(!safe||!Number.isSafeInteger(block)||block<0){this.reset();return {ready:false,count:0,required,stableMs:0};}
    if(block<this.lastBlock)this.reset();
    if(block>this.lastBlock){if(!this.count)this.firstAt=now;this.lastBlock=block;this.count++;}
    const stableMs=this.count?Math.max(0,now-this.firstAt):0;
    return {ready:this.count>=required&&stableMs>=minMs,count:this.count,required,stableMs};
  }
  reset(){this.lastBlock=-1;this.count=0;this.firstAt=0;}
}
