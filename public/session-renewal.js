/** Browser projection of server-confirmed lifetime. No activity-based renewal. */
export class SessionRenewal {
  constructor({request,render,now=Date.now,schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=clearTimeout,
    makeId=()=>crypto.randomUUID()}) {
    Object.assign(this,{request,render,now,schedule,unschedule,makeId});this.epoch=0;this.reset();
  }
  reset(){this.epoch++;this.unschedule(this.timer);this.session=null;this.expiresAt=null;this.pending=false;this.error=null;}
  bind(session,expiresAt,supported){
    if(typeof session!=='string'||!session||!Number.isSafeInteger(expiresAt))return;
    if(this.session!==session){this.reset();this.session=session;}
    this.expiresAt=expiresAt;this.supported=supported===true;this.publish();
  }
  publish(){
    this.unschedule(this.timer);
    if(!this.session)return;
    const remaining=this.expiresAt-this.now(),expired=remaining<=0;
    this.render({expired,warning:!expired&&remaining<=300000,pending:this.pending,error:this.error,
      expiresAt:this.expiresAt,canRenew:this.supported&&!expired&&!this.pending});
    if(!expired)this.timer=this.schedule(()=>this.publish(),Math.max(1,Math.min(remaining,remaining>300000?remaining-300000:1000)));
  }
  async renew(){
    if(!this.session||!this.supported||this.pending||this.now()>=this.expiresAt)return false;
    const epoch=this.epoch,session=this.session,previousExpiresAt=this.expiresAt,requestId=this.makeId();
    this.pending=true;this.error=null;this.publish();
    let timeout;
    try{
      const result=await Promise.race([this.request({sessionId:session,previousExpiresAt,requestId}),
        new Promise((_,reject)=>{timeout=this.schedule(()=>reject(Error('confirmation_timeout')),15000);})]);
      if(epoch!==this.epoch)return false;
      if(this.now()>=previousExpiresAt||result?.sessionId!==session||result.requestId!==requestId||
        result.status!=='committed'||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=previousExpiresAt||
        result.expiresAt>this.now()+3600000)throw Error('renewal_not_confirmed');
      this.expiresAt=result.expiresAt;return true;
    }catch{
      if(epoch===this.epoch)this.error='Renewal was not confirmed.';
      return false;
    }finally{
      this.unschedule(timeout);
      if(epoch===this.epoch){this.pending=false;this.publish();}
    }
  }
}
