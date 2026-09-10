import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SasControl, validSecureDesktopStatus } from '../public/sas-control.js';
const gen='A'.repeat(32), id='12345678-1234-4123-8123-123456789abc';
const message=(extra={})=>({t:'secure_desktop_status',v:1,session_id:'session',generation:gen,id,sequence:1,status:'warning',code:'input_partial',...extra});
function harness(expiry=100000) {
  let clock=1000, serial=0;
  const connection={}, reports=[], sent=[], timers=new Map();
  const control=new SasControl({send:m=>sent.push(m), changed(){}, report(){},secureReport:m=>reports.push(m),now:()=>clock,makeId:()=>id,
    schedule:(fn,delay)=>{timers.set(++serial,{fn,at:clock+delay});return serial;},unschedule:id=>timers.delete(id)});
  const cap=(extra={})=>({t:'control_capabilities',v:1,session_id:'session',generation:gen,expires_at:expiry,sas:{available:true,reason:null},...extra});
  control.bind(connection,'session',expiry);control.consume(cap(),connection);
  return {control,connection,reports,sent,cap,consume:m=>control.consume(m,connection),
    advance(ms){clock+=ms; for(const [key,t] of [...timers])if(t.at<=clock){timers.delete(key);t.fn();}}};
}
test('secure status accepts only exact schema and bounded typed vocabulary',()=>{
  const pairs={observing:['helper_ready'],active:['secure_frame_received'],warning:['input_rejected','input_partial','input_unknown'],returned:['normal_frame_received'],failed:['prepare_failed','helper_lost','deadline_reached','session_changed','capture_unavailable','return_unobserved','cancelled']};
  for(const [status,codes] of Object.entries(pairs))for(const code of codes)assert.equal(validSecureDesktopStatus(message({status,code})),true);
  for(const key of Object.keys(message())){const m=message();delete m[key];assert.equal(validSecureDesktopStatus(m),false);}
  for(const change of [{extra:1},{v:'1'},{sequence:0},{sequence:65},{sequence:1.5},{sequence:'1'},{status:['warning']},{status:{toString:{}}},{status:'toString'},{code:['input_partial']},{status:'returned',code:'helper_ready'},{id:id.toUpperCase()},{id:'00000000-0000-0000-0000-000000000000'},{generation:'a'.repeat(32)}])assert.equal(validSecureDesktopStatus(message(change)),false);
});
test('probe, unrelated request, connection and session never report',()=>{
  const h=harness();h.consume(message());assert.equal(h.reports.length,0);h.control.request();
  h.control.consume(message(),{});
  for(const change of [{id:'22345678-1234-4123-8123-123456789abc'},{session_id:'other'},{generation:'B'.repeat(32)},{extra:'secret'}])h.consume(message(change));
  assert.equal(h.reports.length,0);h.consume(message());assert.equal(h.reports.length,1);assert.equal(h.sent.length,1);
});
test('same-generation unavailable and SAS timeout preserve observation without replay',()=>{
  const h=harness();h.control.request();h.advance(5000);
  h.consume(h.cap({sas:{available:false,reason:'audit_unavailable'}}));
  h.consume(message());h.consume(message({sequence:2,status:'returned',code:'normal_frame_received'}));
  assert.deepEqual(h.reports,[{status:'warning',code:'input_partial'},{status:'returned',code:'normal_frame_received'}]);assert.equal(h.sent.length,1);
});
test('readiness/frames are silent; warnings deduplicate and terminal outcomes cannot regress',()=>{
  const h=harness();h.control.request();
  h.consume(message({status:'observing',code:'helper_ready'}));
  h.consume(message({sequence:2,status:'active',code:'secure_frame_received'}));assert.equal(h.reports.length,0);
  h.consume(message({sequence:3}));h.consume(message({sequence:4}));h.consume(message({sequence:2,code:'input_rejected'}));
  h.consume(message({sequence:5,status:'returned',code:'normal_frame_received'}));
  h.consume(message({sequence:6,status:'failed',code:'helper_lost'}));assert.equal(h.reports.length,2);
});
test('generation, connection, session and malformed capability replacement retire observers',()=>{
  for(const replace of [h=>h.consume(h.cap({generation:'B'.repeat(32)})),h=>h.control.bind({},'session',100000),h=>h.control.bind(h.connection,'different',100000),h=>h.consume(h.cap({extra:true}))]){
    const h=harness();h.control.request();replace(h);h.consume(message());assert.equal(h.reports.length,0);
  }
});
test('observer expires at the earlier of 45 seconds or mint expiry',()=>{
  for(const expiry of [100000,3000]){const h=harness(expiry);h.control.request();h.advance(Math.min(45000,expiry-1000));h.consume(message());assert.equal(h.reports.length,0);assert.equal(h.control.observations.size,0);}
});
test('observer storage is bounded and rejects UUID reuse before expiry',()=>{
  const h=harness();h.control.request();h.advance(5000);assert.equal(h.control.request(),false);
  let n=1;h.control.makeId=()=>`${String(n++).padStart(8,'0')}-1234-4123-8123-123456789abc`;
  for(let i=1;i<128;i++){
    assert.equal(h.control.request(),true);const request=h.sent.at(-1);
    h.consume({t:'command_result',v:1,command:'ctrl-alt-delete',session_id:'session',generation:gen,id:request.id,status:'invoked',code:'native_call_returned',effect:'unverified'});
  }
  assert.equal(h.control.observations.size,128);assert.equal(h.control.request(),false);assert.equal(h.sent.length,128);
  h.advance(45000);assert.equal(h.control.request(),true);assert.equal(h.control.observations.size,1);
});

test('prepared secure expiry survives legacy cutoff and reports expiry without final packet',()=>{
  const h=harness();h.control.request();
  h.consume(message({status:'observing',code:'helper_ready',secureExpiresAt:80000}));
  h.advance(46000);assert.equal(h.control.observations.size,1);assert.equal(h.reports.length,0);
  h.advance(33000);assert.deepEqual(h.reports,[{status:'failed',code:'deadline_reached'}]);
  h.advance(1000);assert.equal(h.reports.length,1);
});
test('prepared deadline cannot widen and completed return does not later report failure',()=>{
  const h=harness();h.control.request();
  h.consume(message({status:'observing',code:'helper_ready',secureExpiresAt:80000}));
  h.consume(message({sequence:2,status:'active',code:'secure_frame_received',secureExpiresAt:90000}));
  assert.equal(h.control.observations.get(id).deadline,80000);
  h.consume(message({sequence:3,status:'returned',code:'normal_frame_received',secureExpiresAt:80000}));
  h.advance(80000);assert.deepEqual(h.reports,[{status:'returned',code:'normal_frame_received'}]);
});
