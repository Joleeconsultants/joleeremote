import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionRenewal} from '../public/session-renewal.js';
function harness(request){let time=1000,state;const c=new SessionRenewal({request,render:s=>state=s,now:()=>time,schedule:()=>1,unschedule(){},makeId:()=> 'request'});
 return {c,get state(){return state;},advance(ms){time+=ms;c.publish();}};}
test('warns five minutes before server expiry and never renews due to activity or timers',()=>{
 let requests=0;const h=harness(()=>requests++);h.c.bind('session',3601000,true);
 assert.equal(h.state.warning,false);h.advance(3300000);assert.equal(h.state.warning,true);assert.equal(requests,0);
 h.advance(300000);assert.equal(h.state.expired,true);assert.equal(h.state.canRenew,false);
});
test('only matching committed response extends expiry',async()=>{
 const h=harness(async r=>({...r,status:'committed',expiresAt:3601000}));h.c.bind('session',301000,true);
 assert.equal(await h.c.renew(),true);assert.equal(h.state.expiresAt,3601000);
 const bad=harness(async()=>({status:'committed',expiresAt:3601000}));bad.c.bind('session',301000,true);
 assert.equal(await bad.c.renew(),false);assert.equal(bad.state.expiresAt,301000);
});
test('late response after expiry does not revive session',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));h.c.bind('session',2000,true);
 const pending=h.c.renew();h.advance(1000);resolve({sessionId:'session',requestId:'request',status:'committed',expiresAt:3601000});
 assert.equal(await pending,false);assert.equal(h.state.expired,true);
});

test('retry after uncertain confirmation retains the exact request and previous deadline',async()=>{
 const requests=[];let count=0;
 const h=harness(async r=>{requests.push(r);if(count++===0)throw Error('network');return {...r,status:'committed',expiresAt:3601000};});
 let ids=0;h.c.makeId=()=>String(++ids);h.c.bind('session',301000,true);
 assert.equal(await h.c.renew(),false);assert.equal(await h.c.renew(),true);
 assert.deepEqual(requests[1],requests[0]);assert.equal(ids,1);
 h.c.reset();assert.equal(h.c.attempt,null);
});
