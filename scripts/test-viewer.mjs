import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

function assistKeyboard() {
  const shell = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const events = {}, sent = [];
  const assist = { value: '', addEventListener: (name, callback) => { events[name] = callback; } };
  vm.runInNewContext(shell.slice(shell.indexOf('var composing = false;'), shell.indexOf('window.addEventListener("requestFileUpload"')), {
    assist, postToCore: value => sent.push(value),
  });
  return { assist, sent, fire: (name, event = {}) => events[name](event) };
}

test('assist commits printable text once and preserves spaces and Unicode scalars', () => {
  const { assist, sent, fire } = assistKeyboard();
  fire('keydown', { key: 'A', code: 'KeyA' });
  assist.value = 'A ! é 😀';
  fire('input');
  fire('keyup', { key: 'A', code: 'KeyA' });
  assert.deepEqual(sent.filter(e => e.e === 'down').map(e => e.key), ['A', ' ', '!', ' ', 'é', ' ', '😀']);
  assert.equal(sent.length, 14);
  assert.ok(sent.every(e => e.code === ''));
  assert.equal(assist.value, '');
});

test('assist defers composition and keeps named controls and physical shortcuts', () => {
  const { assist, sent, fire } = assistKeyboard();
  fire('compositionstart');
  assist.value = 'ni'; fire('input', { isComposing: true });
  fire('keydown', { key: 'Process' });
  assert.equal(sent.length, 0);
  assist.value = '你'; fire('compositionend'); fire('input');
  assert.deepEqual(sent.map(e => e.key), ['你', '你']);
  for (const key of ['Backspace', 'Enter', 'Escape']) {
    fire('keydown', { key, code: '' }); fire('keyup', { key, code: '' });
  }
  fire('keydown', { key: 's', code: 'KeyS', ctrlKey: true });
  fire('keyup', { key: 's', code: 'KeyS', ctrlKey: true });
  assert.equal(sent.length, 10);
  assert.equal(sent[8].code, 'KeyS');
});

// Exercise the shipped browser routine; stub only browser side effects.
const html = readFileSync(new URL('../public/viewer.html', import.meta.url), 'utf8');
test('clipboard writes require matching native confirmation and reject invalid text without truncation',()=>{
  const messages=[],sent=[],timers=new Map();let id=0,timerId=0;
  const c=vm.createContext({window:{parent:{postMessage:m=>messages.push(m)},location:{origin:'https://example.test'}},
    crypto:{randomUUID:()=>String(++id)},agentStats:{clipboard_text_supported:true,clipboard_max_chars:16384},sessionPaired:true,
    sendInput:m=>sent.push(m),parseJsonFrameObject:JSON.parse,
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(html.slice(html.indexOf('let pendingClipboardRequest='),html.indexOf('function consumeScreenAck(')),c);
  vm.runInContext(html.slice(html.indexOf('function clipboardUpdateFromUI('),html.indexOf('const MAX_ENVELOPE_BYTES=')),c);
  c.clipboardUpdateFromUI('é 😀');assert.equal(sent[0].text,'é 😀');assert.equal(messages.length,0);
  c.clipboardUpdateFromUI('new');assert.equal(timers.size,1);
  const ack=(id,status='applied',reason=null)=>c.consumeClipboardResult(JSON.stringify({t:'clipboard_result',id,status,reason}));
  ack('1');ack('2','applied','invalid_text');assert.equal(messages.length,0);
  ack('2');assert.equal(messages[0].status,'applied');assert.equal(timers.size,0);ack('2');assert.equal(messages.length,1);
  for(const text of ['x'.repeat(16385),'bad\0text','\ud800']){c.clipboardUpdateFromUI(text);assert.equal(messages.at(-1).reason,'invalid_text');}
  assert.equal(sent.length,2);
  c.clipboardUpdateFromUI('');assert.equal(sent.at(-1).text,'');
  Array.from(timers.values())[0]();assert.equal(messages.at(-1).reason,'confirmation_timeout');
  c.sessionPaired=false;c.clipboardUpdateFromUI('offline');assert.equal(messages.at(-1).reason,'session_unavailable');
});
const source = html.slice(html.indexOf('function handlePrintFrame(pf){'), html.indexOf('function setVideoEnabled('));
assert.ok(source.startsWith('function handlePrintFrame(pf){'));

function viewer() {
  const previews = [];
  const window = {};
  window.parent = window;
  const context = vm.createContext({
    window, Uint8Array, printJobChunks: new Map(),
    base64ToBytes: data => new Uint8Array(Buffer.from(data, 'base64')),
    openPrintPreview: file => previews.push(file),
  });
  vm.runInContext(source, context);
  const send = (part, data, job = 'job-a', parts = 3) => context.handlePrintFrame({
    job, part, parts, name: 'test.pdf', mime: 'application/pdf',
    data: Buffer.from(data).toString('base64'),
  });
  return { send, previews };
}

test('multipart print waits for every chunk, then assembles in order', () => {
  const { send, previews } = viewer();
  send(0, '%PDF-');
  assert.equal(previews.length, 0);
  send(2, '%%EOF');
  assert.equal(previews.length, 0);
  send(1, 'body');
  assert.equal(previews.length, 1);
  assert.equal(Buffer.from(previews[0].bytes).toString(), '%PDF-body%%EOF');
});

test('out-of-order chunks and duplicate parts do not complete early or mix jobs', () => {
  const { send, previews } = viewer();
  send(2, 'C');
  send(2, 'C');
  send(0, 'X', 'job-b', 2);
  send(0, 'A');
  assert.equal(previews.length, 0);
  send(1, 'B');
  send(1, 'Y', 'job-b', 2);
  assert.deepEqual(previews.map(p => Buffer.from(p.bytes).toString()), ['ABC', 'XY']);
});

test('single-part print still opens immediately', () => {
  const { send, previews } = viewer();
  send(0, 'single', 'job-a', 1);
  assert.equal(previews.length, 1);
  assert.equal(Buffer.from(previews[0].bytes).toString(), 'single');
});

function settingsViewer() {
  const sent=[];
  const window={}; window.parent=window;
  const context=vm.createContext({window, socket:{readyState:0,send:value=>sent.push(JSON.parse(value))},
    stopAudioPlayback:()=>{}, MAX_ENVELOPE_BYTES:1048576, encodeInput:JSON.stringify});
  const statusSource=html.slice(html.indexOf('let sessionPaired='),html.indexOf('function encodeInput('));
  const sendSource=html.slice(html.indexOf('function sendInput('),html.indexOf('function requestFullscreen('));
  vm.runInContext(statusSource+'\n'+sendSource,context);
  return {context,sent};
}

test('settings chosen before socket open or agent join replay latest values on pairing',()=>{
  const {context:c,sent}=settingsViewer();
  c.sendInput({t:'settings',settings:{framerate:30}});
  c.socket.readyState=1;
  c.setStatus('waiting');
  c.sendInput({t:'settings',settings:{framerate:60,jpeg_quality:80}});
  assert.equal(sent.length,0);
  c.setStatus('paired');
  assert.deepEqual(sent,[{t:'settings',settings:{framerate:60,jpeg_quality:80}}]);
  c.setStatus('paired');
  assert.equal(sent.length,1);
});

test('re-pairing restores settings but never replays key or file actions',()=>{
  const {context:c,sent}=settingsViewer();
  c.sendInput({t:'key',e:'down',key:'x'});
  c.sendInput({t:'file',data:'eA=='});
  c.sendInput({t:'settings',settings:{framerate:60}});
  c.socket.readyState=1;
  c.setStatus('paired');
  c.sendInput({t:'settings',settings:{jpeg_quality:90}});
  c.setStatus('waiting');
  c.setStatus('paired');
  assert.deepEqual(sent.at(-1),{t:'settings',settings:{framerate:60,jpeg_quality:90}});
  assert.ok(sent.every(p=>p.t==='settings'));
});

import { debounceSettings, postToCore, listAudioDevices } from '../chrome/selkies-dashboard/src/jolee-bridge.js';

test('speaker enumeration survives unavailable microphone permission', async () => {
  const devices = [{ kind: 'audiooutput', deviceId: 'speaker', label: '' }];
  assert.equal(await listAudioDevices({ enumerateDevices: async () => devices,
    getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } }), devices);
  await assert.rejects(listAudioDevices({ enumerateDevices: async () => [],
    getUserMedia: async () => { throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); } }), { name: 'NotFoundError' });
});

test('audio labels need no repeat permission and temporary microphone tracks are stopped', async () => {
  let stopped = 0, enumerations = 0;
  const labeled = [{ kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }];
  assert.equal(await listAudioDevices({ enumerateDevices: async () => labeled,
    getUserMedia: async () => { throw new Error('must not request'); } }), labeled);
  assert.equal(await listAudioDevices({ enumerateDevices: async () => ++enumerations === 1 ? [] : labeled,
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) }), labeled);
  assert.equal(stopped, 1);
});

test('rapid settings changes preserve different keys and only the latest value per key', async () => {
  const sent = [];
  const post = debounceSettings(value => sent.push(value), 5);
  post({ framerate: 30 });
  post({ jpeg_quality: 60 });
  post({ framerate: 24 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, [{ framerate: 24, jpeg_quality: 60 }]);
  post({ jpeg_quality: 50 });
  post.cancel();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
});

test('core load replays initial and latest settings, never keys or commands', () => {
  const sent = [];
  const listeners = {};
  const frame = { contentWindow: { postMessage: msg => sent.push(structuredClone(msg)) },
    addEventListener: (event, fn) => { listeners[event] = fn; } };
  globalThis.document = { getElementById: () => frame };
  globalThis.window = { location: { origin: 'https://test.invalid' } };
  try {
    postToCore({ type: 'settings', settings: { framerate: 60, jpeg_quality: 80 } });
    postToCore({ type: 'settings', settings: { framerate: 24 } });
    postToCore({ type: 'command', command: 'ctrl-alt-delete' });
    sent.length = 0;
    listeners.load();
    assert.deepEqual(sent, [{ type: 'settings', settings: { framerate: 24, jpeg_quality: 80 } }]);
  } finally { delete globalThis.document; delete globalThis.window; }
});

test('telemetry updates and dashboard polls do not consume partial FPS/bandwidth samples', () => {
  let now = 0;
  const sent = [];
  const c = vm.createContext({ performance: { now: () => now }, consumeScreenAck: () => {}, remoteAudio:{reading:()=>({level:null,state:"unavailable"})},
    window: { parent: { postMessage: value => sent.push(value) }, location: { origin: 'https://test.invalid' } },
    frameCount: 0, statsStartedAt: 0, bytesSinceStats: 0, hopFps: 0, hopBandwidth: 0, agentStats: {}, agentScreen: null, agentStatsReceivedAt: 0, observedEncoder: null, latencyReading: () => null });
  vm.runInContext(html.slice(html.indexOf('function numberOr('), html.indexOf('setInterval(postStats,1000)')), c);
  c.frameCount = 30; c.bytesSinceStats = 125000;
  now = 500; c.postStats();
  assert.equal(c.frameCount, 30);
  now = 1000; c.postStats();
  assert.equal(sent.at(-1).fps, 30);
  assert.equal(sent.at(-1).network_stats.bandwidth_mbps, 1);
  assert.equal(sent.at(-1).system_stats.cpu_percent, null);
  assert.equal(sent.at(-1).system_stats.mem_used, null);
  assert.equal(sent.at(-1).network_stats.latency_ms, null);
  now = 1001; c.agentStats = { system_stats: { cpu_percent: 25 } }; c.postStats();
  assert.equal(sent.at(-1).fps, 30);
  assert.equal(sent.at(-1).network_stats.bandwidth_mbps, 1);
  assert.equal(sent.at(-1).system_stats.cpu_percent, 25);
  c.agentStats = { system_stats: { cpu_percent: 0, mem_used: 0, mem_total: 100 }, network_stats: { latency_ms: 0 } };
  now = 1100; c.postStats();
  assert.equal(sent.at(-1).system_stats.cpu_percent, 0);
  assert.equal(sent.at(-1).system_stats.mem_total, 100);
  assert.equal(sent.at(-1).network_stats.latency_ms, 0);
  now = 2000; c.postStats();
  assert.equal(sent.at(-1).fps, 0);
  assert.equal(sent.at(-1).network_stats.bandwidth_mbps, 0);
  now = 5000; c.postStats();
  assert.equal(sent.at(-1).system_stats.cpu_percent, null);
  assert.equal(sent.at(-1).system_stats.mem_total, null);
  assert.equal(sent.at(-1).network_stats.latency_ms, null);
  c.agentStats = { system_stats: { cpu_percent: 10 } }; c.agentStatsReceivedAt = now;
  c.postStats(); assert.equal(sent.at(-1).system_stats.cpu_percent, 10);
  now = 5500;
  c.acceptAgentStats({t:'stats',screen:{request_id:'screen-1',status:'rejected',reason:'application_disabled'}});
  c.postStats();
  assert.equal(sent.at(-1).system_stats.cpu_percent, 10);
  assert.equal(c.agentStatsReceivedAt, 5000);
  assert.equal(sent.at(-1).screen.request_id, 'screen-1');
  c.observedEncoder = 'jpeg';
  c.agentStats = { active_encoder: 'h264enc', supported_encoders: ['jpeg', 'invalid'], microphone_supported: false };
  c.postStats();
  assert.equal(sent.at(-1).active_encoder, 'jpeg');
  assert.deepEqual(Array.from(sent.at(-1).supported_encoders), ['jpeg']);
  assert.equal(sent.at(-1).microphone_supported, false);
  assert.equal(sent.at(-1).audio_bitrate_supported, null);
});

test('exact-resolution pointer mapping uses the centered native image and smoothing reaches CSS', () => {
  const classes = new Map();
  const c = vm.createContext({ scaleLocally: false, antiAliasing: false, ctx: {},
    canvas: { width: 1280, height: 720, style: {}, classList: { toggle: (name, on) => classes.set(name, on) },
      getBoundingClientRect: () => ({ left: -440, top: 40, width: 1280, height: 720 }) } });
  vm.runInContext(html.slice(html.indexOf('function applyScale('), html.indexOf('function applyCursorMode(')) +
    html.slice(html.indexOf('function contentBox('), html.indexOf('function moveOverlay(')), c);
  c.applyScale(); c.applySmoothing();
  assert.equal(classes.get('exact-resolution'), true);
  assert.equal(c.canvas.style.imageRendering, 'pixelated');
  assert.equal(c.pointerNorm({ clientX: 200, clientY: 400 }).x, 0.5);
  assert.equal(c.pointerNorm({ clientX: 200, clientY: 400 }).y, 0.5);
  c.scaleLocally = true; c.antiAliasing = true; c.applyScale(); c.applySmoothing();
  assert.equal(classes.get('exact-resolution'), false);
  assert.equal(c.canvas.style.imageRendering, 'auto');
});

test('local display preferences replay on iframe load without replaying actions', () => {
  const sent = []; const listeners = {};
  const frame = { contentWindow: { postMessage: value => sent.push(structuredClone(value)) },
    addEventListener: (event, fn) => { listeners[event] = fn; } };
  globalThis.document = { getElementById: () => frame };
  globalThis.window = { location: { origin: 'https://test.invalid' } };
  try {
    postToCore({ type: 'setScaleLocally', value: false });
    postToCore({ type: 'setAntiAliasing', value: false });
    postToCore({ type: 'setAntiAliasing', value: true });
    postToCore({ type: 'command', command: 'ctrl-alt-delete' });
    sent.length = 0; listeners.load();
    assert.deepEqual(sent, [{ type: 'setScaleLocally', value: false }, { type: 'setAntiAliasing', value: true }]);
  } finally { delete globalThis.document; delete globalThis.window; }
});

test('latency accepts only the pending reply and expires samples or disconnected state', () => {
  let now = 0, nonce = 0;
  const sent = [];
  const c = vm.createContext({ stopAudioPlayback:()=>{}, performance: { now: () => now }, crypto: { randomUUID: () => `nonce-${++nonce}` },
    socket: { readyState: 1 }, window: { parent: { postMessage() {} }, location: { origin: 'https://test.invalid' } },
    sendInput: value => sent.push(value), parseJsonFrameObject: value => value, postStats() {} });
  vm.runInContext(html.slice(html.indexOf('let sessionPaired='), html.indexOf('function encodeInput(')), c);
  c.sendLatencyProbe(); assert.equal(sent.length, 0);
  c.setStatus('paired'); c.sendLatencyProbe(); assert.equal(sent.length, 1);
  now = 50; c.sendLatencyProbe(); assert.equal(sent.length, 1);
  c.consumeLatencyReply({ t: 'pong', id: 'other' }); assert.equal(c.latencyReading(now), null);
  c.consumeLatencyReply({ t: 'pong', id: sent[0].id }); assert.equal(c.latencyReading(now), 50);
  now = 75; c.consumeLatencyReply({ t: 'pong', id: sent[0].id }); assert.equal(c.latencyReading(now), 50);
  now = 15050; assert.equal(c.latencyReading(now), null);
  c.sendLatencyProbe(); now += 10001;
  c.consumeLatencyReply({ t: 'pong', id: sent[1].id }); assert.equal(c.latencyReading(now), null);
  c.sendLatencyProbe(); now += 20;
  c.consumeLatencyReply({ t: 'pong', id: sent[2].id }); assert.equal(c.latencyReading(now), 20);
  c.setStatus('waiting'); assert.equal(c.latencyReading(now), null);
  assert.equal(c.consumeLatencyReply({ t: 'stats' }), false);
});

test('screen requests correlate confirmations and clear pending work on disconnect', () => {
  const sent=[], results=[], timers=new Map(); let next=0;
  const c=vm.createContext({
    window:{parent:{postMessage:m=>results.push(m)},location:{origin:'https://test.invalid'}},
    crypto:{randomUUID:()=>`screen-${++next}`},
    setTimeout:fn=>{const id=++next;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    sendInput:m=>sent.push(m),innerWidth:393,innerHeight:735,devicePixelRatio:2,
  });
  vm.runInContext(html.slice(html.indexOf('let sessionPaired='),html.indexOf('let pendingLatency=')),c);
  vm.runInContext('sessionPaired=true; screenAligned=true; screenUseCssScaling=false',c);
  c.requestWindowSize();
  assert.equal(sent[0].w,784); assert.equal(sent[0].h,1456); assert.equal(sent[0].mode,'auto');
  c.requestScreenSize(1920,1080,'manual');
  const active=sent.at(-1);
  c.consumeScreenAck({request_id:sent[0].id,status:'applied',effective:{width:784,height:1456}});
  c.consumeScreenAck({request_id:active.id,status:'applied'});
  assert.equal(results.length,0);
  c.consumeScreenAck({request_id:active.id,status:'rejected',reason:'application_disabled'});
  assert.equal(results.length,1); assert.equal(results[0].reason,'application_disabled');
  c.consumeScreenAck({request_id:active.id,status:'applied',effective:{width:1920,height:1080}});
  assert.equal(results.length,1); assert.equal(timers.size,0);
  c.requestScreenSize(1280,720,'manual');
  [...timers.values()][0]();
  assert.equal(results.at(-1).reason,'confirmation_timeout');
  c.requestScreenSize(1280,720,'manual');
  c.finishScreenRequest('rejected','session_unavailable');
  assert.equal(results.at(-1).reason,'session_unavailable'); assert.equal(timers.size,0);
});

function audioHarness() {
  const sources=[]; let decodeResolve;
  class Context {
    state='suspended';currentTime=0;
    createAnalyser(){return {fftSize:2048,connect(){},getFloatTimeDomainData:out=>out.fill(this.signal||0)};}
    createMediaStreamDestination(){return {stream:{}};}
    resume(){this.state='running';return Promise.resolve();}
    decodeAudioData(){return this.defer?new Promise(resolve=>{decodeResolve=resolve;}):Promise.resolve({duration:0.25});}
    createBufferSource(){const source={connect(){},disconnect(){},start(time){this.time=time;},stop(){this.stopped=true;}};sources.push(source);return source;}
  }
  class Audio {paused=true;play(){this.paused=false;return Promise.resolve();}pause(){this.paused=true;}setSinkId(id){this.sink=id;return Promise.resolve();}}
  const c=vm.createContext({window:{AudioContext:Context},Audio,Float32Array});
  vm.runInContext(html.slice(html.indexOf('class RemoteAudioPlayer'),html.indexOf('function stopAudioPlayback('))+'\nglobalThis.player=remoteAudio;',c);
  return {player:c.player,sources,resolve:()=>decodeResolve({duration:0.25})};
}

test('audio buffers sequential playback, measures signal and expires silence vs missing audio',async()=>{
  const {player,sources}=audioHarness();const bytes=new Uint8Array([1,2]);
  for(let i=0;i<7;i++)player.push(bytes);
  assert.equal(player.queue.length,4);assert.equal(player.reading().level,null);
  await player.unlock();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sources.length,4);
  assert.equal(sources[1].time-sources[0].time,0.25);
  player.context.signal=0.5;
  assert.equal(player.reading().level,71);
  player.context.signal=0;assert.equal(player.reading().state,'silent');assert.equal(player.reading().level,0);
  player.context.currentTime=3;assert.equal(player.reading().level,null);assert.equal(player.reading().state,'waiting');
  await player.setSink('speaker');assert.equal(player.element.sink,'speaker');
  await player.setSink('');assert.equal(player.element.sink,'');
  player.enabled=false;player.stop();assert.equal(player.reading().state,'disabled');assert.ok(sources.every(s=>s.stopped));
});

test('audio decode finishing after teardown cannot restart playback',async()=>{
  const {player,sources,resolve}=audioHarness();await player.unlock();player.context.defer=true;
  player.push(new Uint8Array([1]));player.stop();resolve();
  await new Promise(done=>setImmediate(done));
  assert.equal(sources.length,0);assert.equal(player.queue.length,0);assert.equal(player.reading().level,null);
});

test('fullscreen denial and unsupported API produce explicit parent feedback',async()=>{
  const messages=[];
  const c=vm.createContext({stage:{requestFullscreen:()=>Promise.reject(new Error('not granted'))},window:{parent:{postMessage:m=>messages.push(m)},location:{origin:'https://test.invalid'}}});
  vm.runInContext(html.slice(html.indexOf('function requestFullscreen('),html.indexOf('function showVirtualKeyboard(')),c);
  c.requestFullscreen();await new Promise(done=>setImmediate(done));
  assert.equal(messages.at(-1).type,'fullscreenError');assert.match(messages.at(-1).message,/not granted/);
  c.stage={};c.requestFullscreen();assert.match(messages.at(-1).message,/not supported/);
  c.stage={requestFullscreen:()=>{throw new Error('inactive');}};c.requestFullscreen();assert.equal(messages.length,3);
});
