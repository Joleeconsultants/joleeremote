import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AudioControl} from '../public/audio-control.js';
const cap={t:'audio_capabilities',v:1,sourceGeneration:'a'.repeat(32),codecs:[{codec:'pcm_s16le'},{codec:'mp4a.40.2',sampleRate:48000,channels:2,description:'EZA=',bitratesBps:[96000,128000]}]};
test('AAC needs exact browser support and matched acknowledgement',async()=>{
  const sent=[],applied=[];const c=new AudioControl({send:m=>sent.push(m),applied:m=>applied.push(m),changed(){},makeId:()=> '12345678-1234-1234-1234-123456789abc',Decoder:{isConfigSupported:async()=>({supported:true})}});
  await c.consume(cap);assert.equal(c.select(192000),false);assert.equal(c.select(128000),true);
  assert.equal(applied.length,0);
  const ack={...sent[0],t:'audio_config_result',status:'applied',generation:'b'.repeat(32)};
  await c.consume({...ack,requestId:'wrong'});assert.equal(applied.length,0);
  await c.consume(ack);assert.equal(applied.length,1);
  await c.consume({...ack,codec:'pcm_s16le',reason:'encoder_failed_pcm_fallback'});assert.equal(applied.length,2);
});
test('unsupported and stale asynchronous browser probes cannot offer AAC',async()=>{
  let resolve;const c=new AudioControl({send(){},applied(){},changed(){},Decoder:{isConfigSupported:()=>new Promise(r=>resolve=r)}});
  const pending=c.consume(cap);c.reset();resolve({supported:true});await pending;assert.deepEqual(c.choices,[]);
});
test('off clears pending request and timeout never reports applied or retries',()=>{
  let fire;const sent=[],applied=[],states=[];
  const c=new AudioControl({send:m=>sent.push(m),applied:m=>applied.push(m),changed:m=>states.push(m),schedule:fn=>{fire=fn;return 1;},unschedule(){},makeId:()=> '12345678-1234-1234-1234-123456789abc'});
  c.pcm();const old=fire;c.reset();old();assert.equal(c.pending,null);assert.equal(states.at(-1).error,undefined);
  c.pcm();fire();assert.ok(c.pending);assert.equal(states.at(-1).error,'confirmation_timeout');
  assert.equal(applied.length,0);assert.equal(sent.length,2);
});
test('late AAC ack reconciles after timeout and rapid choices serialize',async()=>{
  let fire,n=0;const sent=[],applied=[];
  const c=new AudioControl({send:m=>sent.push(m),applied:m=>applied.push(m),changed(){},schedule:fn=>{fire=fn;return 1;},unschedule(){},makeId:()=>`00000000-0000-0000-0000-${String(++n).padStart(12,'0')}`,Decoder:{isConfigSupported:async()=>({supported:true})}});
  await c.consume(cap);c.select(96000);c.select(128000);assert.equal(sent.length,1);
  fire();const ack={...sent[0],t:'audio_config_result',status:'applied',generation:'c'.repeat(32)};
  await c.consume(ack);assert.equal(applied.length,1);assert.equal(sent.length,2);assert.equal(c.active.targetBitrate,96000);
  await c.consume({...ack,requestId:sent[1].requestId,status:'rejected',reason:'encoder_unavailable'});
  assert.equal(c.active.targetBitrate,96000);assert.equal(c.pending,null);
  c.pcm();fire();await c.consume({...ack,requestId:sent[2].requestId,codec:'pcm_s16le',generation:'d'.repeat(32)});
  assert.equal(c.active.codec,'pcm_s16le');assert.equal(applied.length,2);
});
