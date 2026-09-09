import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const mime='audio/pcm;format=s16le;rate=24000;channels=1';
test('viewer only forwards negotiated bounded PCM with metadata and drops socket backlog',()=>{
  const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
  const start=html.indexOf('    case "micChunk":')+'    case "micChunk":'.length;
  const source=html.slice(start,html.indexOf('      break;',start));
  const sent=[];
  const c=vm.createContext({sessionPaired:true,microphoneForwarding:true,agentStats:{microphone_supported:true,microphone_formats:[mime]},
    agentStatsReceivedAt:0,performance:{now:()=>0},socket:{bufferedAmount:0},sendInput:m=>sent.push(m),
    msg:{mime,sample_rate:24000,channels:1,sequence:0,data:'A'.repeat(3200)}});
  vm.runInContext(source,c);assert.equal(sent.length,1);assert.equal(sent[0].sequence,0);assert.equal(sent[0].sample_rate,24000);
  c.socket.bufferedAmount=65536;vm.runInContext(source,c);assert.equal(sent.length,1);
  c.socket.bufferedAmount=0;c.agentStats.microphone_formats=[];vm.runInContext(source,c);assert.equal(sent.length,1);
  c.agentStats.microphone_formats=[mime];c.msg.mime='audio/mp4';vm.runInContext(source,c);assert.equal(sent.length,1);
});
const capture=readFileSync(new URL('../chrome/selkies-dashboard/src/jolee-mic-pcm-capture.js',import.meta.url),'utf8')
  .replace(/^import .*;$/m,'').replaceAll('export function ','function ').replaceAll('export async function ','async function ');
function fixture(){
  const requests=[],contexts=[],nodes=[],sent=[];
  class Audio {
    destination={}; closed=false;
    audioWorklet={addModule:async()=>{}};
    constructor(){contexts.push(this);}
    resume(){return Promise.resolve();}
    close(){this.closed=true;return Promise.resolve();}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
  }
  class Node {
    port={onmessage:null,postMessage(){},close(){}};
    constructor(){nodes.push(this);}
    connect(){} disconnect(){}
  }
  const c=vm.createContext({ArrayBuffer,Uint8Array,AudioWorkletNode:Node,btoa:s=>Buffer.from(s,'binary').toString('base64'),
    window:{AudioContext:Audio,location:{origin:'https://fixture.invalid'},postMessage(){}},
    navigator:{mediaDevices:{getUserMedia:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))}},postToCore:m=>sent.push(m)});
  vm.runInContext(capture,c);
  return {c,requests,contexts,nodes,sent};
}
function stream(){const track={stopped:false,stop(){this.stopped=true;},addEventListener(){}};return {track,getTracks:()=>[track]};}
test('PCM capture requires exact negotiated format and stopped permission grants release tracks',async()=>{
  const f=fixture();assert.equal(await f.c.startParentMicrophone(),false);assert.equal(f.requests.length,0);
  assert.equal(f.c.setParentMicFormats(['audio/mp4']),false);
  f.c.setParentMicFormats([mime]);const pending=f.c.startParentMicrophone();f.c.stopParentMicrophone();
  const s=stream();f.requests[0].resolve(s);assert.equal(await pending,false);
  assert.equal(s.track.stopped,true);assert.equal(f.contexts[0].closed,true);assert.equal(f.nodes.length,0);
});
test('PCM capture frames carry exact metadata and OFF cannot revive or deliver a queued block',async()=>{
  const f=fixture();f.c.setParentMicFormats([mime]);const p=f.c.startParentMicrophone();
  const s=stream();f.requests[0].resolve(s);assert.equal(await p,true);
  const receive=f.nodes[0].port.onmessage;
  receive({data:{buffer:new ArrayBuffer(2400),sequence:0}});
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.length,3200);
  assert.equal(f.sent[0].sample_rate,24000);assert.equal(f.sent[0].channels,1);assert.equal(f.sent[0].mime,mime);
  receive({data:{buffer:new ArrayBuffer(2401),sequence:1}});assert.equal(f.sent.length,1);
  f.c.stopParentMicrophone();receive({data:{buffer:new ArrayBuffer(2400),sequence:2}});
  assert.equal(f.sent.length,1);assert.equal(s.track.stopped,true);assert.equal(f.contexts[0].closed,true);
});
test('a superseded microphone request cannot release the replacement stream',async()=>{
  const f=fixture();f.c.setParentMicFormats([mime]);const a=f.c.startParentMicrophone();f.c.stopParentMicrophone();const b=f.c.startParentMicrophone();
  const fresh=stream();f.requests[1].resolve(fresh);assert.equal(await b,true);
  const old=stream();f.requests[0].resolve(old);assert.equal(await a,false);
  assert.equal(old.track.stopped,true);assert.equal(fresh.track.stopped,false);f.c.stopParentMicrophone();
});
const processor=readFileSync(new URL('../public/mic-pcm-worklet.js',import.meta.url),'utf8');
function worklet(rate){
  let Processor;const sent=[];
  class Base {port={postMessage:m=>sent.push(m),onmessage:null};}
  vm.runInNewContext(processor,{AudioWorkletProcessor:Base,sampleRate:rate,registerProcessor:(name,p)=>Processor=p});
  return {p:new Processor(),sent};
}
test('worklet resamples 44.1/48kHz stereo to exact 24kHz mono PCM16 and outputs only silence',()=>{
  for(const rate of [44100,48000]){
    const {p,sent}=worklet(rate);let produced=0;
    for(let remaining=rate;remaining>0;){
      const n=Math.min(128,remaining);remaining-=n;
      const output=new Float32Array(n).fill(1);
      p.process([[new Float32Array(n).fill(1),new Float32Array(n).fill(-0.5)]],[[output]]);
      assert.ok(output.every(v=>v===0));
      while(sent.length){const block=sent.shift();produced+=block.buffer.byteLength/2;const view=new DataView(block.buffer);
        assert.equal(view.getInt16(0,true),8192);p.port.onmessage({data:{ack:block.sequence}});}
    }
    assert.equal(produced,24000);
  }
});
test('worklet bounds pending blocks, drops during backpressure, and preserves monotonic sequence',()=>{
  const {p,sent}=worklet(24000);
  for(let i=0;i<10;i++)p.process([[new Float32Array(1200)]],[]);
  assert.equal(sent.length,1);assert.equal(sent[0].sequence,0);
  p.port.onmessage({data:{ack:999}});p.process([[new Float32Array(1200)]],[]);assert.equal(sent.length,1);
  p.port.onmessage({data:{ack:0}});p.process([[new Float32Array(1200)]],[]);
  assert.equal(sent.length,2);assert.equal(sent[1].sequence,11);
});
