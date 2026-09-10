import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('class NegotiatedVideo'),html.indexOf('const negotiatedVideo='));
const key=new Uint8Array([0,0,0,1,9,0,0,0,1,0x67,66,0,0,1,0x68,0,0,0,1,0x65,1]);
const delta=new Uint8Array([0,0,1,0x41,1]);
const config=(generation='one')=>({t:'video_config',generation,encoder:'h264enc',codec:'avc1.42c014',format:'annexb',width:320,height:240,
  colorSpace:{matrix:'bt709',primaries:'bt709',transfer:'bt709',fullRange:false}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness(support=async()=>({supported:true})){
  const instances=[],decoded=[],painted=[],fallback=[],timers=new Map();let id=0,now=0;
  class Decoder {
    static isConfigSupported= support;
    constructor(callbacks){this.callbacks=callbacks;this.decodeQueueSize=0;instances.push(this);}
    configure(options){this.options=options;}
    decode(chunk){decoded.push(chunk);}
    close(){this.closed=true;}
  }
  const c=vm.createContext({performance:{now:()=>now},VideoDecoder:Decoder,EncodedVideoChunk:class{constructor(options){Object.assign(this,options);}},
    setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source+'\nglobalThis.Consumer=NegotiatedVideo;',c);
  const consumer=new c.Consumer(frame=>painted.push(frame),reason=>fallback.push(reason));
  return {consumer,instances,decoded,painted,fallback,timers,advance:ms=>{now+=ms;}};
}
test('native Annex B config uses actual codec and coded dimensions, queues in order and requires parameter sets plus IDR',async()=>{
  const h=harness();h.consumer.configure(config());h.consumer.push(key);h.consumer.push(delta);await settle();
  assert.equal(h.instances[0].options.codec,'avc1.42c014');
  assert.equal(h.instances[0].options.codedWidth,320);assert.equal(h.instances[0].options.codedHeight,240);
  assert.deepEqual(h.decoded.map(c=>c.type),['key','delta']);assert.equal(h.fallback.length,0);
  h.consumer.configure(config('two'));h.consumer.push(delta);await settle();assert.equal(h.fallback.length,1);
  h.consumer.push(key);assert.equal(h.fallback.length,1);
});
test('late support checks, old decoder output and old errors cannot revive a reset generation',async()=>{
  let resolve;const h=harness(()=>new Promise(r=>resolve=r));h.consumer.configure(config());await settle();
  h.consumer.reset();resolve({supported:true});await settle();assert.equal(h.instances.length,0);
  h.consumer.configure(config('two'));await settle();resolve({supported:true});await settle();
  const old=h.instances[0];h.consumer.configure({generation:'jpeg',encoder:'jpeg'});
  let closed=0;old.callbacks.output({close:()=>closed++});old.callbacks.error(new Error('late'));
  assert.equal(h.painted.length,0);assert.equal(closed,1);assert.equal(h.fallback.length,0);
});
test('unsupported config, malformed dimensions, missing WebCodecs and decode errors request JPEG once',async()=>{
  for(const overrides of [{width:0},{width:321},{codec:'bad'},{colorSpace:{}},{generation:''}]){
    const h=harness();h.consumer.configure({...config(),...overrides});h.consumer.push(key);h.consumer.push(delta);
    assert.equal(h.fallback.length,1);assert.equal(h.instances.length,0);
  }
  const h=harness(async()=>({supported:false}));h.consumer.configure(config());await settle();
  h.consumer.configure(config());h.consumer.push(key);assert.equal(h.fallback.length,1);
  const ok=harness();ok.consumer.configure(config());await settle();ok.instances[0].callbacks.error();ok.instances[0].callbacks.error();
  assert.equal(ok.fallback.length,1);
  const c=vm.createContext({setTimeout,clearTimeout});vm.runInContext(source+'\nglobalThis.Consumer=NegotiatedVideo;',c);
  let count=0;new c.Consumer(()=>{},()=>count++).configure(config());assert.equal(count,1);
});
test('bounded buffering and support timeout recover while temporary decode pressure preserves reference frames',async()=>{
  const pending=harness(()=>new Promise(()=>{}));pending.consumer.configure(config());
  for(let i=0;i<33;i++)pending.consumer.push(key);assert.equal(pending.fallback.length,1);assert.equal(pending.consumer.pending.length,0);
  const timeout=harness(()=>new Promise(()=>{}));timeout.consumer.configure(config());[...timeout.timers.values()][0]();
  assert.equal(timeout.fallback.length,1);
  const h=harness();h.consumer.configure(config());await settle();h.consumer.push(key);h.instances[0].decodeQueueSize=8;h.consumer.push(delta);
  assert.equal(h.decoded.length,1);assert.equal(h.fallback.length,0);assert.equal(h.consumer.pending.length,1);
  h.instances[0].decodeQueueSize=0;h.instances[0].callbacks.output({close(){}});
  assert.equal(h.decoded.length,2);assert.equal(h.decoded[1].type,'delta');assert.equal(h.consumer.pending.length,0);
});
test('Annex B type parsing tolerates AUD and SEI prefixes and rejects missing parameter sets or forbidden headers',()=>{
  const c=vm.createContext({});vm.runInContext(source,c);
  assert.equal(c.annexBChunkType(key),'key');assert.equal(c.annexBChunkType(delta),'delta');
  for(const bytes of [[0,0,1,0x65,1],[0,0,1,0xc1,1],[1,2,3],[0,0,0,1]])assert.equal(c.annexBChunkType(bytes),null);
});
test('a decoder that accepts input without output is bounded and eventually requests JPEG',async()=>{
  const h=harness();h.consumer.configure(config());await settle();h.consumer.push(key);
  for(let i=0;i<40;i++)h.consumer.push(delta);
  assert.equal(h.decoded.length,8);assert.equal(h.fallback.length,1);
  const stalled=harness();stalled.consumer.configure(config());await settle();stalled.consumer.push(key);
  [...stalled.timers.values()][0]();assert.equal(stalled.fallback.length,1);
  const healthy=harness();healthy.consumer.configure(config());await settle();healthy.consumer.push(key);
  let closed=0;healthy.instances[0].callbacks.output({close:()=>closed++});
  assert.equal(healthy.consumer.inFlight,0);assert.equal(healthy.timers.size,0);assert.equal(closed,1);
});

test('H264 startup without any access units requests JPEG once and a new generation can recover',async()=>{
  const h=harness();h.consumer.configure(config());await settle();
  assert.equal(h.decoded.length,0);
  assert.equal(h.timers.size,1,'decoder support alone must not end the startup deadline');
  const expired=[...h.timers.values()][0];expired();expired();
  assert.equal(h.fallback.length,1);
  h.consumer.configure(config('recovered'));await settle();h.consumer.push(key);
  assert.equal(h.timers.size,1,'first input replaces the startup timer');
  h.instances.at(-1).callbacks.output({close(){}});
  assert.equal(h.painted.length,1);assert.equal(h.timers.size,0);
  expired();assert.equal(h.fallback.length,1);
});

test('reset or JPEG transition cancels the no-frame startup deadline',async()=>{
  for(const action of ['reset','jpeg']){
    const h=harness();h.consumer.configure(config());await settle();
    assert.equal(h.timers.size,1);
    const expired=[...h.timers.values()][0];
    if(action==='reset')h.consumer.reset();else h.consumer.configure({generation:'image',encoder:'jpeg'});
    assert.equal(h.timers.size,0);expired();assert.equal(h.fallback.length,0);
  }
});
test('a slow first output does not falsely fall back and queued references drain in order',async()=>{
  const h=harness();h.consumer.configure(config());await settle();h.consumer.push(key);
  for(let i=0;i<11;i++){h.advance(33);h.consumer.push(delta);}
  assert.equal(h.decoded.length,8);assert.equal(h.consumer.pending.length,4);assert.equal(h.fallback.length,0);
  for(let i=0;i<12;i++)h.instances[0].callbacks.output({close(){}});
  assert.equal(h.decoded.length,12);assert.equal(h.consumer.inFlight,0);assert.equal(h.consumer.pending.length,0);
  assert.deepEqual(h.decoded.map(c=>c.type),['key',...Array(11).fill('delta')]);assert.equal(h.fallback.length,0);
});
test('sustained queued latency after output starts requests JPEG instead of accumulating lag',async()=>{
  const h=harness();h.consumer.configure(config());await settle();h.consumer.push(key);
  h.instances[0].callbacks.output({close(){}});
  for(let i=0;i<9;i++)h.consumer.push(delta);
  h.advance(501);h.instances[0].callbacks.output({close(){}});
  assert.equal(h.fallback.length,1);assert.equal(h.consumer.pending.length,0);
});
test('decoder dequeue wakes pending input and stale dequeue cannot revive a reset stream',async()=>{
  const h=harness();h.consumer.configure(config());await settle();const decoder=h.instances[0];
  decoder.decodeQueueSize=8;h.consumer.push(key);assert.equal(h.decoded.length,0);
  decoder.decodeQueueSize=0;decoder.ondequeue();assert.equal(h.decoded.length,1);
  h.consumer.reset();decoder.ondequeue();assert.equal(h.decoded.length,1);assert.equal(h.fallback.length,0);
});

test('fallback preserves a bounded diagnostic reason and never reports a stale generation',async()=>{
  const unsupported=harness(async()=>({supported:false}));unsupported.consumer.configure(config());await settle();
  assert.deepEqual(unsupported.fallback,['unsupported_codec']);
  const backlog=harness();backlog.consumer.configure(config());await settle();backlog.consumer.push(key);
  backlog.instances[0].callbacks.output({close(){}});backlog.instances[0].decodeQueueSize=8;
  backlog.consumer.push(delta);backlog.advance(501);backlog.consumer.drain();
  assert.deepEqual(backlog.fallback,['decoder_backlog']);
  const timer=harness(()=>new Promise(()=>{}));timer.consumer.configure(config());[...timer.timers.values()][0]();
  assert.deepEqual(timer.fallback,['decoder_timeout']);
});
