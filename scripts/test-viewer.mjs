import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSetDpi, initialDpi } from '../chrome/selkies-dashboard/src/jolee-dpi-settings.js';
import { SasControl } from '../public/sas-control.js';
import { ClipboardPasteGate } from '../public/clipboard-paste.js';
import { UploadControl } from '../public/upload-control.js';
function viewerContext(globals) {
  globals={printJobChunks:new Map(),...globals};
  return vm.createContext({ canvas:{dataset:{}},setMicrophoneForwarding:()=>{},resetRemoteCursor:()=>{},pointerInput:{reset(){}},clearTimeout:()=>{},session:'fixture-session', SasControl, structuredClone, sasControl:{consume:()=>false,request:()=>{},publish:()=>{}}, ClipboardPasteGate, clipboardPaste: new ClipboardPasteGate({ send() {}, report() {}, supported: () => false, connection: () => null }), ...globals,
    UploadControl,uploadControl:{bind(){},capability(){},consume(){return false;}},crypto:{subtle:webcrypto.subtle,...globals.crypto} });
}
import { createClipboardDelivery, clipboardImageBlob } from '../chrome/selkies-dashboard/src/jolee-clipboard-delivery.js';

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
test('native audio health validates state-dependent facts and expires without inventing silence',()=>{
  const c=viewerContext({});
  vm.runInContext(html.slice(html.indexOf('function audioCaptureReading('),html.indexOf('function acceptAgentStats(')),c);
  const valid={state:'streaming',sample_rate_hz:48000,channels:2,sample_format:'pcm_s16le',last_chunk_age_ms:100,reason:null};
  assert.equal(c.audioCaptureReading(valid,0).state,'streaming');
  assert.equal(c.audioCaptureReading(valid,1401).state,'waiting');
  assert.equal(c.audioCaptureReading(valid,3500),null);
  assert.equal(c.audioCaptureReading(valid,-1),null);
  assert.equal(c.audioCaptureReading(undefined,0),null);
  for(const change of [{state:'silent'},{channels:6},{sample_rate_hz:7999},{sample_rate_hz:48000.5},{sample_format:'float32'},
    {last_chunk_age_ms:-1},{last_chunk_age_ms:60001},{last_chunk_age_ms:1501},{reason:'device-error'},{state:'waiting'}])
    assert.equal(c.audioCaptureReading({...valid,...change},0),null);
  const waiting={...valid,state:'waiting',last_chunk_age_ms:59999};
  assert.equal(c.audioCaptureReading(waiting,2000).last_chunk_age_ms,60000);
  for(const state of ['disabled','starting','unavailable']){
    const value={state,sample_rate_hz:null,channels:null,sample_format:null,last_chunk_age_ms:null,reason:state==='unavailable'?'helper_failed':null};
    assert.equal(c.audioCaptureReading(value,0).state,state);
    assert.equal(c.audioCaptureReading({...value,sample_rate_hz:48000},0),null);
  }
});

test('audio tooltip refreshes capture and playback when other metrics stay constant',()=>{
  const sidebar=readFileSync(new URL('../chrome/selkies-dashboard/src/components/Sidebar.jsx',import.meta.url),'utf8');
  const body=sidebar.slice(sidebar.indexOf('case "audio": {')+'case "audio": {'.length,sidebar.indexOf('case "bandwidth":'));
  const poll=sidebar.slice(sidebar.indexOf('const readStats = () => {'),sidebar.indexOf('const intervalId = setInterval(readStats'));
  const values={},changed=[];
  const c=vm.createContext({window:{currentAudioLevel:null,audioPlaybackState:'blocked',audioCaptureReceivedAt:0,
    audioCaptureStatus:{state:'streaming',sample_rate_hz:48000,channels:2}},
    document:{hidden:false},isOpen:true,performance:{now:()=>0},audioLevel:null,
    audioPlaybackStatus:'unavailable',audioCaptureDescription:'PC capture: unknown',t:(_key,{value})=>`Audio level ${value}`});
  for(const name of new Set(poll.match(/set[A-Z]\w+(?=\()/g))) c[name]=value=>{
    if(!Object.is(values[name],value)) changed.push(name);
    values[name]=value;
    if(name==='setAudioLevel') c.audioLevel=value;
    if(name==='setAudioPlaybackStatus') c.audioPlaybackStatus=value;
    if(name==='setAudioCaptureDescription') c.audioCaptureDescription=value;
  };
  vm.runInContext('function tooltip(){'+body+poll+'globalThis.poll=readStats;',c);
  c.poll();
  assert.equal(c.tooltip(),'Audio: blocked; PC capture: streaming (48000 Hz, 2 ch, PCM16)');
  for(const state of ['waiting','unavailable']){
    changed.length=0;c.window.audioCaptureStatus={state};c.poll();
    assert.deepEqual(changed,['setAudioCaptureDescription']);
    assert.equal(c.tooltip(),`Audio: blocked; PC capture: ${state}`);
  }
  changed.length=0;c.performance.now=()=>3500;c.poll();
  assert.deepEqual(changed,['setAudioCaptureDescription']);
  assert.equal(c.tooltip(),'Audio: blocked; PC capture: unknown');
  changed.length=0;c.window.audioPlaybackState='waiting';c.poll();
  assert.deepEqual(changed,['setAudioPlaybackStatus']);
  assert.equal(c.tooltip(),'Audio: waiting; PC capture: unknown');
  c.window.currentAudioLevel=0;c.poll();
  assert.equal(c.tooltip(),'Audio level 0; PC capture: unknown');
  c.window.audioPlaybackState='playing';c.poll();
  assert.equal(c.tooltip(),'Audio level <1; PC capture: unknown');
  assert.match(sidebar,/useState\('PC capture: unknown'\)/);
  assert.match(sidebar,/audioLevel,\s*audioPlaybackStatus,\s*audioCaptureDescription/);
});
test('clipboard writes require matching native confirmation and reject invalid text without truncation',()=>{
  const messages=[],sent=[],timers=new Map();let id=0,timerId=0;
  const c=viewerContext({window:{parent:{postMessage:m=>messages.push(m)},location:{origin:'https://example.test'}},
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
  const timers=new Map();let nextTimer=0;
  const window = {};
  window.parent = window;
  const context = viewerContext({
    window, Uint8Array, printJobChunks: new Map(),sessionPaired:true,
    setTimeout:callback=>{timers.set(++nextTimer,callback);return nextTimer;},clearTimeout:id=>timers.delete(id),
    base64ToBytes: data => new Uint8Array(Buffer.from(data, 'base64')),
    openPrintPreview: file => previews.push(file),
  });
  vm.runInContext(source, context);
  const send = (part, data, job = 'job-a', parts = 3) => context.handlePrintFrame({
    job, part, parts, name: 'test.pdf', mime: 'application/pdf',
    data: Buffer.from(data).toString('base64'),
  });
  return { send, previews,context,timers };
}

test('print assembly bounds parts, concurrent jobs, duplicates and lifetime',()=>{
  const {send,previews,context,timers}=viewer();
  send(0,'x','huge',87);assert.equal(context.printJobChunks.size,0);
  for(let i=0;i<5;i++)send(0,'x','job-'+i,2);
  assert.equal(context.printJobChunks.size,4);
  send(0,'changed','job-0',2);assert.equal(context.printJobChunks.has('job-0'),false);
  assert.equal(timers.size,3);
  for(const callback of timers.values())callback();
  assert.equal(context.printJobChunks.size,0);assert.equal(previews.length,0);
  context.sessionPaired=false;send(0,'single','closed',1);assert.equal(previews.length,0);
});

test('print assembly rejects aggregate overflow and inconsistent metadata',()=>{
  const {send,context,previews}=viewer();
  send(0,'a','limit',2);context.printJobChunks.get('limit').total=16777216;
  send(1,'b','limit',2);assert.equal(context.printJobChunks.size,0);
  send(0,'a','metadata',2);
  context.handlePrintFrame({job:'metadata',part:1,parts:2,name:'other.pdf',mime:'application/pdf',data:'Yg=='});
  assert.equal(context.printJobChunks.size,0);assert.equal(previews.length,0);
});

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
  const context=viewerContext({window, agentStats:{},agentStatsReceivedAt:0,performance:{now:()=>100}, socket:{readyState:0,send:value=>sent.push(JSON.parse(value))},
    stopAudioPlayback:()=>{}, stopWebcam:()=>{}, invalidateVideoFrames:()=>{}, MAX_ENVELOPE_BYTES:1048576, encodeInput:JSON.stringify});
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
  assert.deepEqual(sent,[{t:'settings',settings:{video_protocol:1,max_edge:3840,framerate:60,jpeg_quality:80}}]);
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
  assert.deepEqual(sent.at(-1),{t:'settings',settings:{video_protocol:1,max_edge:3840,framerate:60,jpeg_quality:90}});
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
  const c = viewerContext({ performance: { now: () => now }, consumeScreenAck: () => {}, remoteAudio:{reading:()=>({level:null,state:"unavailable"})},
    window: { parent: { postMessage: value => sent.push(value) }, location: { origin: 'https://test.invalid' } },
    sessionPaired: true, frameCount: 0, statsStartedAt: 0, bytesSinceStats: 0, hopFps: 0, hopBandwidth: 0, agentStats: {}, agentScreen: null, agentStatsReceivedAt: 0, observedEncoder: null, latencyReading: () => null });
  vm.runInContext(html.slice(html.indexOf('function numberOr('), html.indexOf('setInterval(postStats,1000)')), c);
  c.agentStats={print_forwarding:{supported:true,state:'ready',mode:'pdf_folder',folder:'C:\\Session\\Print',max_bytes:16777216}};
  c.postStats();assert.equal(c.canvas.dataset.printFolder,'C:\\Session\\Print');
  assert.equal(sent.at(-1).print_forwarding.folder,'C:\\Session\\Print');
  c.sessionPaired=false;c.postStats();assert.equal(c.canvas.dataset.printFolder,undefined);
  c.sessionPaired=true;now=5000;c.postStats();assert.equal(sent.at(-1).print_forwarding,null);
  now=0;c.agentStats={};c.statsStartedAt=0;
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
  c.sessionPaired=false; c.postStats(); assert.equal(sent.at(-1).screen,null);
  c.sessionPaired=true;
  c.observedEncoder = 'jpeg';
  c.agentStats = { active_encoder: 'h264enc', supported_encoders: ['jpeg', 'invalid'], microphone_supported: false };
  c.postStats();
  assert.equal(sent.at(-1).active_encoder, 'jpeg');
  assert.deepEqual(Array.from(sent.at(-1).supported_encoders), ['jpeg']);
  assert.equal(sent.at(-1).microphone_supported, false);
  assert.equal(sent.at(-1).audio_bitrate_supported, null);
  for(const state of ['off','waiting','forwarding','unavailable']){
    Object.assign(c.agentStats,{webcam_supported:true,webcam_capture:{supported:true,state}});
    c.postStats();assert.equal(sent.at(-1).webcam_capture.state,state);
  }
  c.agentStats.webcam_capture={supported:true,state:'invented'};c.postStats();assert.equal(sent.at(-1).webcam_capture,null);
  c.agentStats.webcam_capture={supported:true,state:'waiting'};
  c.sessionPaired=false;c.postStats();assert.equal(sent.at(-1).webcam_capture,null);assert.equal(sent.at(-1).webcam_supported,null);
  c.sessionPaired=true;
  Object.assign(c.agentStats,{capture_backend:'dxgi',capture_max_edge:3840,jpeg_quality_effective:40});
  c.postStats();
  assert.equal(sent.at(-1).capture_backend,'dxgi');assert.equal(sent.at(-1).capture_max_edge,3840);
  assert.equal(sent.at(-1).jpeg_quality_effective,40);
  c.observedEncoder='h264enc';c.postStats();assert.equal(sent.at(-1).jpeg_quality_effective,null);
  c.observedEncoder='jpeg';Object.assign(c.agentStats,{capture_backend:'invented',capture_max_edge:9000,jpeg_quality_effective:101});
  c.postStats();assert.equal(sent.at(-1).capture_backend,null);assert.equal(sent.at(-1).capture_max_edge,null);assert.equal(sent.at(-1).jpeg_quality_effective,null);
  Object.assign(c.agentStats,{capture_backend:'gdi-bootstrap',capture_max_edge:320,jpeg_quality_effective:1});
  c.agentStatsReceivedAt=now;c.postStats();assert.equal(sent.at(-1).jpeg_quality_effective,1);
  now+=5000;c.postStats();assert.equal(sent.at(-1).capture_backend,null);assert.equal(sent.at(-1).capture_max_edge,null);assert.equal(sent.at(-1).jpeg_quality_effective,null);
  assert.equal(sent.at(-1).screen,null);
  assert.equal(sent.at(-1).webcam_capture,null);assert.equal(sent.at(-1).webcam_supported,null);
});

test('exact-resolution pointer mapping uses the centered native image and smoothing reaches CSS', () => {
  const classes = new Map();
  const c = viewerContext({ scaleLocally: false, antiAliasing: false, ctx: {},
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
    postToCore({ type: 'setUseBrowserCursors', value: false });
    postToCore({ type: 'setUseBrowserCursors', value: true });
    postToCore({ type: 'command', command: 'ctrl-alt-delete' });
    sent.length = 0; listeners.load();
    assert.deepEqual(sent, [{ type: 'setScaleLocally', value: false }, { type: 'setAntiAliasing', value: true }, { type: 'setUseBrowserCursors', value: true }]);
  } finally { delete globalThis.document; delete globalThis.window; }
});

test('latency accepts only the pending reply and expires samples or disconnected state', () => {
  let now = 0, nonce = 0;
  const sent = [];
  const c = viewerContext({ stopAudioPlayback:()=>{}, stopWebcam:()=>{}, invalidateVideoFrames:()=>{}, performance: { now: () => now }, crypto: { randomUUID: () => `nonce-${++nonce}` },
    socket: { readyState: 1 }, window: { parent: { postMessage() {} }, location: { origin: 'https://test.invalid' } },
    sendInput: value => sent.push(value), parseJsonFrameObject: value => value, postStats() {} });
  vm.runInContext(html.slice(html.indexOf('let sessionPaired='), html.indexOf('function encodeInput(')), c);
  c.sendLatencyProbe(); assert.equal(sent.length, 0);
  c.setStatus('paired'); assert.equal(sent.pop().settings.video_protocol,1); c.sendLatencyProbe(); assert.equal(sent.length, 1);
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
  const c=viewerContext({
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
  const c=viewerContext({window:{AudioContext:Context},Audio,Float32Array});
  vm.runInContext(html.slice(html.indexOf('class RemoteAudioPlayer'),html.indexOf('function stopAudioPlayback('))+'\nglobalThis.player=remoteAudio;',c);
  return {player:c.player,sources,resolve:()=>decodeResolve({duration:0.25})};
}

test('failed output routing preserves the last applied sink and audio can start again',async()=>{
  const {player}=audioHarness();player.ensure();await player.setSink('speaker-ok');
  const apply=player.element.setSinkId.bind(player.element);
  player.element.setSinkId=id=>id==='missing'?Promise.reject(new Error('device removed')):apply(id);
  await assert.rejects(player.setSink('missing'));
  assert.equal(player.sinkId,'speaker-ok');assert.equal(player.element.sink,'speaker-ok');
  await player.unlock();assert.equal(player.state,'waiting');
});

test('output selection before playback is applied and concurrent changes finish in user order',async()=>{
  const {player}=audioHarness();await player.setSink('first');
  assert.equal(player.element.sink,'first');
  const pending=[];player.element.setSinkId=id=>new Promise(resolve=>pending.push(()=>{player.element.sink=id;resolve();}));
  const a=player.setSink('second'),b=player.setSink('third');
  await new Promise(done=>setImmediate(done));assert.equal(pending.length,1);
  pending.shift()();await a;await new Promise(done=>setImmediate(done));
  assert.equal(pending.length,1);pending.shift()();await b;
  assert.equal(player.sinkId,'third');assert.equal(player.element.sink,'third');
});

test('output UI feedback reports the applied sink and ignores superseded requests',async()=>{
  const messages=[],errors=[],pending=[];
  const remoteAudio={sinkId:'default',setSink:id=>new Promise((resolve,reject)=>pending.push({id,resolve:()=>{remoteAudio.sinkId=id;resolve();},reject}))};
  const c=viewerContext({remoteAudio,audioEnabled:true,audioSinkId:'default',postPipelineStatus:(...args)=>errors.push(args),
    window:{parent:{postMessage:m=>messages.push(m)},location:{origin:'https://test.invalid'}}});
  vm.runInContext(html.slice(html.indexOf('let audioOutputRequest='),html.indexOf('function postPipelineStatus(')),c);
  const a=c.selectAudioOutput('speaker'),b=c.selectAudioOutput('missing');
  pending[0].resolve();await a;assert.equal(messages.length,0);
  pending[1].reject(Error('missing'));await b;
  assert.equal(messages.at(-1).deviceId,'speaker');assert.equal(c.audioSinkId,'speaker');assert.equal(errors.length,1);
  const d=c.selectAudioOutput('');pending[2].resolve();await d;assert.equal(messages.at(-1).deviceId,'default');
});

test('audio buffers sequential playback, measures signal and expires silence vs missing audio',async()=>{
  const {player,sources}=audioHarness();const bytes=new Uint8Array([1,2]);
  for(let i=0;i<7;i++)player.push(bytes);
  assert.equal(player.queue.length,4);assert.equal(player.reading().level,null);
  await player.unlock();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sources.length,4);
  assert.equal(sources[1].time-sources[0].time,0.25);
  player.context.signal=0.5;
  assert.equal(player.reading().level,71);
  player.context.signal=0.001;assert.equal(player.reading().level,0);assert.equal(player.reading().state,'playing');
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
  const c=viewerContext({stage:{requestFullscreen:()=>Promise.reject(new Error('not granted'))},window:{parent:{postMessage:m=>messages.push(m)},location:{origin:'https://test.invalid'}}});
  vm.runInContext(html.slice(html.indexOf('function requestFullscreen('),html.indexOf('function showVirtualKeyboard(')),c);
  c.requestFullscreen();await new Promise(done=>setImmediate(done));
  assert.equal(messages.at(-1).type,'fullscreenError');assert.match(messages.at(-1).message,/not granted/);
  c.stage={};c.requestFullscreen();assert.match(messages.at(-1).message,/not supported/);
  c.stage={requestFullscreen:()=>{throw new Error('inactive');}};c.requestFullscreen();assert.equal(messages.length,3);
});


test('late JPEG decodes cannot overwrite newer frames or repaint disabled/reconnected video',async()=>{
  const pending=[],painted=[],closed=[];
  const c=viewerContext({negotiatedVideo:{reset:()=>{}},videoGeneration:0,receivedFrameSequence:0,latestPaintedFrame:0,videoEnabled:true,videoDecoder:null,
    canvas:{},ctx:{drawImage:b=>painted.push(b.id)},applySmoothing:()=>{},observedEncoder:null,frameCount:0,Blob,
    createImageBitmap:()=>new Promise(resolve=>pending.push(resolve))});
  vm.runInContext(html.slice(html.indexOf('function invalidateVideoFrames('),html.indexOf('async function paintH264(')),c);
  const bitmap=id=>({id,width:10,height:10,close:()=>closed.push(id)});
  const a=c.paintJpegOrPng([255,216]),b=c.paintJpegOrPng([255,216]);
  pending[1](bitmap('new'));await b;pending[0](bitmap('old'));await a;
  assert.deepEqual(painted,['new']);assert.equal(c.frameCount,1);
  const late=c.paintJpegOrPng([255,216]);c.invalidateVideoFrames();pending[2](bitmap('prior session'));await late;
  const off=c.paintJpegOrPng([255,216]);c.videoEnabled=false;pending[3](bitmap('disabled'));await off;
  assert.deepEqual(painted,['new']);assert.deepEqual(closed,['new','old','prior session','disabled']);
  c.videoEnabled=true;const resumed=c.paintJpegOrPng([255,216]);pending[4](bitmap('resumed'));await resumed;
  assert.deepEqual(painted,['new','resumed']);assert.equal(c.frameCount,2);
});


test('webcam capture requires confirmed support and a late permission grant cannot restart a stopped camera',async()=>{
  let resolveCamera,calls=0,stopped=0;const status=[];
  const c=viewerContext({agentStats:{},sessionPaired:true,agentStatsReceivedAt:0,performance:{now:()=>0},sendInput:()=>{},webcamGen:0,webcamStarting:false,webcamStream:null,webcamTimer:null,
    navigator:{mediaDevices:{getUserMedia:()=>{calls++;return new Promise(resolve=>resolveCamera=resolve);}}},
    clearInterval:()=>{},postPipelineStatus:(...args)=>status.push(args)});
  vm.runInContext(html.slice(html.indexOf('function stopWebcam('),html.indexOf('function downloadFile(')),c);
  await c.setWebcamEnabled(true);assert.equal(calls,0);assert.equal(status.at(-1)[1],false);
  c.agentStats.webcam_supported=true;const pending=c.setWebcamEnabled(true);await c.setWebcamEnabled(true);assert.equal(calls,1);
  c.stopWebcam();resolveCamera({getTracks:()=>[{stop:()=>stopped++}]});await pending;
  assert.equal(stopped,1);assert.equal(c.webcamStream,null);assert.equal(c.webcamStarting,false);assert.ok(status.every(x=>x[1]===false));
});

test('DPI does not replay across capability loss or reconnect while other settings survive',()=>{
  const {context:c,sent}=settingsViewer();
  c.socket.readyState=1;c.setStatus('paired');
  c.agentStats={dpi_scaling_supported:true};
  c.sendInput({t:'settings',settings:{scaling_dpi:144,framerate:8}});
  assert.equal(sent.at(-1).settings.scaling_dpi,144);
  c.agentStats={dpi_scaling_supported:false};
  c.sendInput({t:'settings',settings:{scaling_dpi:192,jpeg_quality:50}});
  assert.equal(Object.hasOwn(sent.at(-1).settings,'scaling_dpi'),false);
  c.setStatus('waiting');c.setStatus('paired');
  assert.deepEqual(sent.at(-1).settings,{video_protocol:1,max_edge:3840,framerate:8,jpeg_quality:50});
  c.agentStats={dpi_scaling_supported:true};
  c.sendInput({t:'settings',settings:{scaling_dpi:120}});
  c.setStatus('waiting');c.setStatus('paired');
  assert.equal(Object.hasOwn(sent.at(-1).settings,'scaling_dpi'),false);
});

test('DPI rejects expired capability without dropping coalesced settings',()=>{
  const {context:c,sent}=settingsViewer();
  c.socket.readyState=1;c.setStatus('paired');
  c.agentStats={dpi_scaling_supported:true};c.performance.now=()=>5000;
  c.sendInput({t:'settings',settings:{scaling_dpi:144,framerate:8}});
  assert.equal(Object.hasOwn(sent.at(-1).settings,'scaling_dpi'),false);
  assert.equal(sent.at(-1).settings.framerate,8);
});

test('webcam normalizes portrait frames, bounds encoding, and retires on expired support',async()=>{
  let now=0,tick,stopped=0;const sent=[],draws=[],blobs=[];
  const video={readyState:2,videoWidth:1080,videoHeight:1920,play:async()=>{}};
  const canvas={getContext:()=>({fillRect(){},drawImage:(...args)=>draws.push(args)}),toBlob:callback=>blobs.push(callback)};
  const c=viewerContext({sessionPaired:true,agentStats:{webcam_supported:true},agentStatsReceivedAt:0,
    performance:{now:()=>now},webcamGen:0,webcamStarting:false,webcamStream:null,webcamTimer:null,
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>stopped++}]})}},
    document:{createElement:name=>name==='video'?video:canvas},
    setInterval:callback=>{tick=callback;return 1;},clearInterval(){},postPipelineStatus(){},
    bytesToBase64:()=> 'frame',sendInput:message=>sent.push(message)});
  vm.runInContext(html.slice(html.indexOf('function stopWebcam('),html.indexOf('function downloadFile(')),c);
  await c.setWebcamEnabled(true);
  assert.equal(canvas.width,640);assert.equal(canvas.height,480);
  assert.deepEqual(draws[0].slice(1),[185,0,270,480]);
  tick();assert.equal(blobs.length,1,'only one encode may be in flight');
  await blobs.shift()({size:262145,arrayBuffer:()=>{throw Error('oversize must not be read');}});
  tick();await blobs.shift()({size:32,arrayBuffer:async()=>new ArrayBuffer(32)});
  assert.equal(sent.filter(x=>x.t==='webcam').length,1);
  now=499;tick();assert.equal(blobs.length,0);
  now=500;tick();assert.equal(blobs.length,1);
  c.stopWebcam();await blobs.shift()({size:32,arrayBuffer:async()=>new ArrayBuffer(32)});
  assert.equal(sent.filter(x=>x.t==='webcam').length,1,'OFF drops pending frames');
  assert.equal(sent.at(-1).enabled,false);assert.equal(stopped,1);
  await c.setWebcamEnabled(true);
  now=5001;await blobs.shift()({size:32,arrayBuffer:async()=>new ArrayBuffer(32)});
  assert.equal(stopped,2);assert.equal(sent.at(-1).enabled,false);
  assert.equal(sent.filter(x=>x.t==='webcam').length,1,'stale support cannot forward');
});

test('replaced sockets cannot change status, deliver data or close the current session',()=>{
  const sockets=[],states=[];
  class Socket {
    constructor(){this.listeners={};this.maxRetries=3;sockets.push(this);}
    addEventListener(name,fn){this.listeners[name]=fn;}
    close(){this.closed=true;}
    fire(name,event={}){this.listeners[name](event);}
  }
  const c=viewerContext({PartySocket:Socket,URL,session:'test',token:'owned-test-token',hop:'',socket:null,
    location:{host:'test.invalid',href:'https://test.invalid/viewer.html'},history:{replaceState:()=>{}},
    videoDecoder:null,stopAudioPlayback:()=>{},stopMicrophone:()=>{},stopWebcam:()=>{},printJobChunks:new Map(),
    setStatus:s=>states.push(s),decodeEnvelope:()=>{throw new Error('stale binary message consumed');}});
  vm.runInContext(html.slice(html.indexOf('function disconnect(){'),html.indexOf('function sendInput(')),c);
  c.connect();const old=sockets[0];c.connect();const current=sockets[1];
  current.fire('open');current.fire('message',{data:JSON.stringify({type:'status',state:'paired'})});
  const count=states.length;
  old.fire('open');old.fire('message',{data:JSON.stringify({type:'status',state:'expired'})});
  old.fire('message',{data:new ArrayBuffer(2)});old.fire('close',{code:4000});
  assert.equal(states.length,count);assert.equal(states.at(-1),'paired');
  assert.equal(c.socket,current);assert.equal(current.closed,undefined);assert.equal(current.maxRetries,3);
  current.fire('close',{code:4000});assert.equal(current.closed,true);assert.equal(c.socket,null);
  assert.equal(states.at(-1),'disconnected');
});

test('audio start finishing after stop cannot revive state or overwrite the stopped status',async()=>{
  const {player}=audioHarness();player.ensure();let resume;
  player.context.resume=()=>new Promise(resolve=>{resume=()=>{player.context.state='running';resolve();};});
  const pending=player.unlock();player.stop();resume();await pending;
  assert.equal(player.state,'unavailable');assert.equal(player.element.paused,true);
  let rejectStart;player.context.resume=()=>new Promise((resolve,reject)=>{rejectStart=reject;});
  const rejected=player.unlock();player.stop();rejectStart(new Error('late failure'));await rejected;
  assert.equal(player.state,'unavailable');
});

test('DPI selection requires confirmed endpoint support before persisting or sending a change',()=>{
  const sidebar=readFileSync(new URL('../chrome/selkies-dashboard/src/components/Sidebar.jsx',import.meta.url),'utf8');
  const changes=[];
  const c=viewerContext({canSetDpi,serverSettings:{scaling_dpi:{allowed:['96','144']}},agentCapabilities:{},setSelectedDpi:v=>changes.push(v),
    localStorage:{setItem:(...args)=>changes.push(args)},getPrefixedKey:k=>k,debouncedPostSetting:v=>changes.push(v)});
  vm.runInContext(sidebar.slice(sidebar.indexOf('const handleDpiScalingChange ='),sidebar.indexOf('const DRAG_THRESHOLD ='))+'\nglobalThis.changeDpi=handleDpiScalingChange;',c);
  for(const support of [undefined,null,false]){c.agentCapabilities.dpi_scaling_supported=support;c.changeDpi({target:{value:'144'}});}
  assert.equal(changes.length,0);
  c.agentCapabilities.dpi_scaling_supported=true;c.changeDpi({target:{value:'144'}});
  assert.equal(changes[0],144);assert.equal(changes[2].scaling_dpi,144);
});

test('reset-to-window preserves DPI storage and posts nothing when unsupported',()=>{
  const sidebar=readFileSync(new URL('../chrome/selkies-dashboard/src/components/Sidebar.jsx',import.meta.url),'utf8');
  const changes=[];
  const c=viewerContext({canSetDpi,serverSettings:{scaling_dpi:{allowed:['96','144']}},agentCapabilities:{},
    deriveDpiFromDpr:()=>144,setSelectedDpi:v=>changes.push(v),
    localStorage:{removeItem:key=>changes.push(key)},getPrefixedKey:k=>k,debouncedPostSetting:v=>changes.push(v)});
  const start=sidebar.indexOf('const resetDpiToDerivedDefault =');
  const end=sidebar.indexOf('\n  };',start)+6;
  vm.runInContext(sidebar.slice(start,end)+'\nglobalThis.resetDpi=resetDpiToDerivedDefault;',c);
  c.resetDpi();c.agentCapabilities.dpi_scaling_supported=false;c.resetDpi();
  assert.equal(changes.length,0);
  c.agentCapabilities.dpi_scaling_supported=true;c.resetDpi();
  assert.equal(changes[0],'scaling_dpi');assert.equal(changes[1],144);assert.equal(changes[2].scaling_dpi,144);
});

test('DPI initialization effect executes with only its own lexical dependencies',()=>{
  const sidebar=readFileSync(new URL('../chrome/selkies-dashboard/src/components/Sidebar.jsx',import.meta.url),'utf8');
  const start=sidebar.indexOf('  useEffect(() => {',sidebar.indexOf('// Capability may arrive after settings.'));
  const end=sidebar.indexOf('  /* eslint-enable react-hooks/set-state-in-effect */',start);
  const values=[],posts=[];
  const c=viewerContext({initialDpi,useEffect:fn=>fn(),serverSettings:{scaling_dpi:{value:'96',allowed:['96','144']}},
    agentCapabilities:{},localStorage:{getItem:()=>null},getPrefixedKey:k=>k,deriveDpiFromDpr:()=>144,
    setSelectedDpi:v=>values.push(v),debouncedPostSetting:v=>posts.push(v)});
  vm.runInContext(sidebar.slice(start,end),c);
  assert.equal(values[0],144);assert.equal(posts.length,0);
  c.agentCapabilities.dpi_scaling_supported=true;vm.runInContext(sidebar.slice(start,end),c);
  assert.equal(posts[0].scaling_dpi,144);
});

function imageClipboardViewer(){
  const messages=[],sent=[],timers=new Map();let id=0,timerId=0;
  const c=viewerContext({Blob,Uint8Array,DataView,Set,window:{parent:{postMessage:m=>messages.push(m)},location:{origin:'https://example.test'}},
    crypto:{randomUUID:()=>String(++id)},agentStats:{clipboard_image_supported:true},latestSettings:{},sessionPaired:true,
    socket:{readyState:1,send:value=>sent.push(JSON.parse(value))},sendInput:m=>sent.push(m),encodeInput:JSON.stringify,
    btoa:value=>Buffer.from(value,'binary').toString('base64'),atob:value=>Buffer.from(value,'base64').toString('binary'),parseJsonFrameObject:JSON.parse,
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(html.slice(html.indexOf('let pendingClipboardRequest='),html.indexOf('function consumeScreenAck(')),c);
  vm.runInContext(html.slice(html.indexOf('function clipboardUpdateFromUI('),html.indexOf('async function sendFile(')),c);
  vm.runInContext(html.slice(html.indexOf('function clipboardTextFromFrame('),html.indexOf('function cursorFromFrame(')),c);
  return {c,messages,sent,timers};
}
const clipboardPng=()=>new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64')],{type:'image/png'});

test('incoming clipboard images enforce PNG bounds and ignore disabled or unpaired delivery',async()=>{
  const {c}=imageClipboardViewer();
  const data=Buffer.from(await clipboardPng().arrayBuffer()).toString('base64');
  const read=(changes={})=>c.clipboardTextFromFrame(JSON.stringify({t:'clipboard',mime:'image/png',data,...changes}));
  assert.equal(read().kind,'image');
  assert.equal(read({mime:'image/svg+xml'}).reason,'unsupported');
  assert.equal(read({data:'%%%%'}).reason,'invalid_image');
  assert.equal(read({data:'AAAA'}).reason,'invalid_image');
  const huge=Buffer.from(data,'base64');huge.writeUInt32BE(4097,16);
  assert.equal(read({data:huge.toString('base64')}).reason,'image_too_large');
  c.agentStats.clipboard_image_max_bytes=1;assert.equal(read().reason,'image_too_large');
  c.latestSettings.enable_binary_clipboard=false;assert.equal(read().kind,'ignored');
  c.latestSettings.enable_binary_clipboard=true;c.sessionPaired=false;assert.equal(read().kind,'ignored');
  assert.equal(c.clipboardTextFromFrame(JSON.stringify({t:'clipboard',text:'unchanged'})).text,'unchanged');
});
test('image clipboard waits for exact native ack and read failures never complete a write',async()=>{
  const {c,messages,sent,timers}=imageClipboardViewer();
  await c.clipboardImageUpdateFromUI(clipboardPng());
  assert.equal(sent.length,1);assert.equal(sent[0].mime,'image/png');assert.equal(sent[0].id,'1');assert.equal(messages.length,0);
  const ack=value=>c.consumeClipboardResult(JSON.stringify({t:'clipboard_result',...value}));
  ack({id:null,direction:'read',sequence:'7',status:'rejected',reason:'image_too_large'});
  ack({id:null,direction:'read',sequence:'7',status:'rejected',reason:'image_too_large'});
  assert.equal(messages.length,1);assert.equal(messages[0].type,'clipboardReadError');assert.equal(timers.size,1);
  ack({id:'other',status:'applied',reason:null});assert.equal(messages.length,1);
  ack({id:'1',status:'applied',reason:null});assert.equal(messages.at(-1).kind,'image');assert.equal(messages.at(-1).status,'applied');assert.equal(timers.size,0);
});
test('late image conversion cannot replace newer text or write into a replaced connection',async()=>{
  const {c,sent,messages}=imageClipboardViewer();let resolve;
  c.normalizeClipboardImage=()=>new Promise(r=>resolve=r);
  const first=c.clipboardImageUpdateFromUI(clipboardPng());c.clipboardUpdateFromUI('newer');resolve(new Uint8Array([1,2]));await first;
  assert.equal(sent.length,1);assert.equal(sent[0].text,'newer');assert.equal(messages.length,0);
  const second=c.clipboardImageUpdateFromUI(clipboardPng());c.socket={readyState:1,send:()=>assert.fail('stale image sent')};resolve(new Uint8Array([1]));await second;
  assert.equal(messages.at(-1).reason,'session_unavailable');assert.equal(sent.length,1);
});

test('image diagnostic receipt exposes only the exact native result and submitted wire hash',async()=>{
  const {c,sent,timers}=imageClipboardViewer();
  const blob=clipboardPng();
  await c.clipboardImageUpdateFromUI(blob);
  assert.equal(c.canvas.dataset.clipboardReceipt,undefined);
  const ack=(id,status='applied',reason=null)=>c.consumeClipboardResult(JSON.stringify({t:'clipboard_result',id,status,reason,paste_token:'secret-token'}));
  ack('other');ack('1','applied','invalid_image');
  assert.equal(c.canvas.dataset.clipboardReceipt,undefined);
  ack('1');
  const receipt=JSON.parse(c.canvas.dataset.clipboardReceipt);
  assert.deepEqual(Object.keys(receipt).sort(),['clipboardId','mime','receivedAt','sessionId','status','wireSha256']);
  const expected=Buffer.from(await webcrypto.subtle.digest('SHA-256',Buffer.from(sent[0].data,'base64'))).toString('hex');
  assert.equal(receipt.wireSha256,expected);
  assert.equal(receipt.sessionId,'fixture-session');assert.equal(receipt.clipboardId,'1');
  assert.equal(receipt.status,'applied');assert.equal(receipt.mime,'image/png');
  assert.ok(Number.isFinite(Date.parse(receipt.receivedAt)));
  const saved=c.canvas.dataset.clipboardReceipt;ack('1','rejected','invalid_image');
  assert.equal(c.canvas.dataset.clipboardReceipt,saved);
  c.clipboardUpdateFromUI('replacement');assert.equal(c.canvas.dataset.clipboardReceipt,undefined);
  [...timers.values()][0]();assert.equal(c.canvas.dataset.clipboardReceipt,undefined);
});

test('hashing an image cannot send after timeout or replacement',async()=>{
  const {c,sent,timers}=imageClipboardViewer();let finishHash,hashStarted;
  const started=new Promise(resolve=>{hashStarted=resolve;});
  c.crypto.subtle={digest:()=>{hashStarted();return new Promise(resolve=>{finishHash=resolve;});}};
  const write=c.clipboardImageUpdateFromUI(clipboardPng());
  await started;[...timers.values()][0]();
  finishHash(new Uint8Array(32).buffer);await write;
  assert.equal(sent.length,0);assert.equal(c.canvas.dataset.clipboardReceipt,undefined);
});
test('image clipboard enforces capability, toggle, payload, PNG geometry and animation bounds',async()=>{
  const {c,sent,messages}=imageClipboardViewer();
  c.agentStats.clipboard_image_supported=false;await c.clipboardImageUpdateFromUI(clipboardPng());assert.equal(messages.at(-1).reason,'unsupported');
  c.agentStats.clipboard_image_supported=true;c.latestSettings.enable_binary_clipboard=false;await c.clipboardImageUpdateFromUI(clipboardPng());assert.equal(messages.at(-1).reason,'unsupported');
  c.latestSettings.enable_binary_clipboard=true;c.agentStats.clipboard_image_max_bytes=1;await c.clipboardImageUpdateFromUI(clipboardPng());assert.equal(messages.at(-1).reason,'image_too_large');
  delete c.agentStats.clipboard_image_max_bytes;
  const bytes=new Uint8Array(await clipboardPng().arrayBuffer());new DataView(bytes.buffer).setUint32(16,4097);
  await c.clipboardImageUpdateFromUI(new Blob([bytes],{type:'image/png'}));assert.equal(messages.at(-1).reason,'image_too_large');
  await c.clipboardImageUpdateFromUI(new Blob(['not PNG'],{type:'image/png'}));assert.equal(messages.at(-1).reason,'invalid_image');
  const png=new Uint8Array(await clipboardPng().arrayBuffer()),actl=Buffer.alloc(20);actl.writeUInt32BE(8);actl.write('acTL',4);
  await c.clipboardImageUpdateFromUI(new Blob([png.slice(0,33),actl,png.slice(33)],{type:'image/png'}));assert.equal(messages.at(-1).reason,'unsupported');
  assert.equal(sent.length,0);
});
test('image write timeout and disabling during conversion suppress late delivery',async()=>{
  const {c,sent,messages,timers}=imageClipboardViewer();let resolve;
  c.normalizeClipboardImage=()=>new Promise(r=>resolve=r);
  const first=c.clipboardImageUpdateFromUI(clipboardPng());[...timers.values()][0]();resolve(new Uint8Array([1]));await first;
  assert.equal(messages.at(-1).reason,'confirmation_timeout');assert.equal(sent.length,0);
  const second=c.clipboardImageUpdateFromUI(clipboardPng());c.latestSettings.enable_binary_clipboard=false;resolve(new Uint8Array([1]));await second;
  assert.equal(messages.at(-1).reason,'unsupported');assert.equal(sent.length,0);
});

test('JPEG dimensions are checked before allocating a decoded image',()=>{
  const {c}=imageClipboardViewer(),limits={dimension:4096,pixels:8388608};
  const jpeg=Uint8Array.from([255,216,255,192,0,8,8,0,2,0,3,1]);
  assert.doesNotThrow(()=>c.checkClipboardJpeg(jpeg,limits));
  jpeg[9]=32;assert.throws(()=>c.checkClipboardJpeg(jpeg,limits),/image_too_large/);
  assert.throws(()=>c.checkClipboardJpeg(Uint8Array.from([255,216,255,218]),limits),/invalid_image/);
});

test('WebP preflight bounds both canvas and bitstream dimensions and rejects animation/truncation',()=>{
  const {c}=imageClipboardViewer(),limits={dimension:4096,pixels:8388608};
  const chunk=(name,data)=>{const b=Buffer.alloc(8+data.length+data.length%2);b.write(name);b.writeUInt32LE(data.length,4);data.copy(b,8);return b;};
  const riff=(...chunks)=>{const b=Buffer.concat([Buffer.from('RIFF0000WEBP'),...chunks]);b.writeUInt32LE(b.length-8,4);return b;};
  const lossless=Buffer.from([47,0,0,0,0]);
  const image=chunk('VP8L',lossless);
  assert.doesNotThrow(()=>c.checkClipboardWebp(riff(image),limits));
  const lossy=Buffer.from([0,0,0,157,1,42,2,0,3,0]);
  assert.doesNotThrow(()=>c.checkClipboardWebp(riff(chunk('VP8 ',lossy)),limits));
  lossy.writeUInt16LE(4097,6);assert.throws(()=>c.checkClipboardWebp(riff(chunk('VP8 ',lossy)),limits),/image_too_large/);
  const extended=Buffer.alloc(10);
  assert.doesNotThrow(()=>c.checkClipboardWebp(riff(chunk('VP8X',extended),image),limits));
  extended[4]=1;assert.throws(()=>c.checkClipboardWebp(riff(chunk('VP8X',extended),image),limits),/invalid_image/);extended[4]=0;
  extended[0]=2;assert.throws(()=>c.checkClipboardWebp(riff(chunk('VP8X',extended),image),limits),/unsupported/);
  extended[0]=0;extended.writeUIntLE(4096,4,3);
  assert.throws(()=>c.checkClipboardWebp(riff(chunk('VP8X',extended),image),limits),/image_too_large/);
  lossless.writeUInt32LE(4096,1);assert.throws(()=>c.checkClipboardWebp(riff(chunk('VP8L',lossless)),limits),/image_too_large/);
  assert.throws(()=>c.checkClipboardWebp(riff(image,chunk('ANMF',Buffer.alloc(16))),limits),/unsupported/);
  assert.throws(()=>c.checkClipboardWebp(riff(image,image),limits),/invalid_image/);
  const bad=riff(image);bad[bad.length-1]=1;assert.throws(()=>c.checkClipboardWebp(bad,limits),/invalid_image/);
  assert.throws(()=>c.checkClipboardWebp(riff(image).subarray(0,25),limits),/invalid_image/);
});

test('browser image delivery retries permission denial only on flush and reports actual success',async()=>{
  const outcomes=[],writes=[];let allowed=false;
  const delivery=createClipboardDelivery({enabled:()=>true,report:v=>outcomes.push(v),write:blob=>{
    writes.push(blob);if(!allowed)throw Object.assign(new Error('activation'),{name:'NotAllowedError'});
  }});
  const blob=clipboardPng();await delivery.receive(blob);
  assert.deepEqual(outcomes,['gesture_required']);assert.equal(writes.length,1);
  await delivery.flush();assert.equal(writes.length,2);assert.equal(outcomes.length,1);
  allowed=true;await delivery.flush();assert.deepEqual(outcomes,['gesture_required','applied']);
  await delivery.flush();assert.equal(writes.length,3);
});

test('browser image writes serialize newest values and stale failures cannot replace them',async()=>{
  const outcomes=[],writes=[];let finish;
  const delivery=createClipboardDelivery({enabled:()=>true,report:v=>outcomes.push(v),write:blob=>{
    writes.push(blob);return new Promise((resolve,reject)=>{finish={resolve,reject};});
  }});
  const first=delivery.receive('first');delivery.receive('second');delivery.receive('newest');
  assert.deepEqual(writes,['first']);finish.reject(Object.assign(new Error(),{name:'NotAllowedError'}));await first;
  assert.deepEqual(writes,['first','newest']);assert.deepEqual(outcomes,[]);
  const last=delivery.flush();finish.resolve();await last;
  assert.deepEqual(outcomes,['applied']);
});

test('browser clipboard reset and disabled state discard pending content and late callbacks',async()=>{
  const outcomes=[],writes=[];let enabled=true,finish;
  const delivery=createClipboardDelivery({enabled:()=>enabled,report:v=>outcomes.push(v),write:blob=>{
    writes.push(blob);return new Promise((resolve,reject)=>{finish={resolve,reject};});
  }});
  const old=delivery.receive('old-session');delivery.clear();finish.resolve();await old;
  assert.deepEqual(outcomes,[]);
  const current=delivery.receive('current');finish.reject(Object.assign(new Error(),{name:'NotAllowedError'}));await current;
  enabled=false;delivery.flush();enabled=true;delivery.flush();assert.equal(writes.length,2);
  assert.deepEqual(outcomes,['gesture_required']);
});

test('browser delivery reports unsupported failures without retry and preserves PNG bytes',async()=>{
  const outcomes=[];let writes=0;
  const delivery=createClipboardDelivery({enabled:()=>true,report:v=>outcomes.push(v),write:()=>{writes++;throw new TypeError('No ClipboardItem');}});
  await delivery.receive(clipboardPng());delivery.flush();assert.equal(writes,1);assert.deepEqual(outcomes,['failed']);
  const expected=Buffer.from(await clipboardPng().arrayBuffer());
  const received=clipboardImageBlob({mime:'image/png',data:expected.toString('base64')});
  assert.equal(received.type,'image/png');assert.deepEqual(Buffer.from(await received.arrayBuffer()),expected);
  assert.throws(()=>clipboardImageBlob({mime:'image/svg+xml',data:'AAAA'}));
  assert.throws(()=>clipboardImageBlob({mime:'image/png',data:'AB=='}));
});
test('text replaces a blocked image in the same queue and Image Support OFF preserves text delivery',async()=>{
  const written=[];let enabled=true,allow=false;
  const delivery=createClipboardDelivery({enabled:c=>typeof c==='string'||enabled,report(){},write:c=>{
    written.push(c);if(!allow)throw Object.assign(new Error(),{name:'NotAllowedError'});
  }});
  await delivery.receive(clipboardPng());await delivery.receive('newer text');
  enabled=false;delivery.clearImages();allow=true;await delivery.flush();
  assert.equal(written.at(-1),'newer text');assert.equal(written.length,3);
  await delivery.receive(clipboardPng());assert.equal(written.length,3);
  await delivery.receive('text while images disabled');assert.equal(written.at(-1),'text while images disabled');
});

function pasteHarness() {
  const sent=[],reported=[],timers=new Map();let serial=0,clock=0,connection={},supported=true;
  const gate=new ClipboardPasteGate({send:p=>sent.push(p),report:(status,reason)=>reported.push({status,reason}),
    connection:()=>connection,supported:()=>supported,uuid:()=>`paste-${++serial}`,
    schedule:fn=>{timers.set(++clock,fn);return clock;},unschedule:id=>timers.delete(id)});
  const key=(key,e='down',gesture={})=>gate.key({t:'key',key,e,code:key==='Control'?'ControlLeft':key==='v'?'KeyV':key},
    {trusted:true,...gesture});
  return {gate,sent,reported,timers,key,replaceConnection:()=>{connection={};},disable:()=>{supported=false;}};
}
const pasteToken='0123456789abcdef0123456789abcdef';
test('pending Paste waits for both clipboard confirmation and actual modifier/V release in either order',()=>{
  for(const ackFirst of [true,false]) {
    const {gate,sent,key}=pasteHarness();gate.begin('image-1');
    key('Control');key('v','down',{ctrlKey:true});key('v','down',{ctrlKey:true});
    if(ackFirst)gate.settle('image-1','applied',pasteToken);
    assert.equal(sent.length,1);key('v','up',{ctrlKey:true});assert.equal(sent.length,1);
    key('Control','up');
    if(!ackFirst){assert.equal(sent.length,2);gate.settle('image-1','applied',pasteToken);}
    assert.deepEqual(sent.map(p=>p.t),['key','key','clipboard_paste']);
    assert.equal(sent[1].e,'up');assert.equal(sent[2].clipboard_id,'image-1');assert.equal(sent[2].paste_token,pasteToken);
    gate.settle('image-1','applied',pasteToken);gate.flush();assert.equal(sent.length,3);gate.reset();
  }
});
test('clipboard uploads do not implicitly Paste and ordinary shortcut keys remain unchanged',()=>{
  const {gate,sent,key}=pasteHarness();gate.begin('image-1');gate.settle('image-1','applied',pasteToken);
  assert.equal(sent.length,0);key('Control');key('v','down',{ctrlKey:true});key('v','up',{ctrlKey:true});key('Control','up');
  assert.equal(sent.length,4);assert.ok(sent.every(p=>p.t==='key'));gate.reset();
});
test('Paste cannot dispatch while an already-held modifier was pressed outside the canvas',()=>{
  const {gate,key,sent}=pasteHarness();gate.begin('image-1');key('v','down',{ctrlKey:true});
  gate.settle('image-1','applied',pasteToken);key('v','up',{ctrlKey:true});assert.equal(sent.length,0);
  key('Control','up',{ctrlKey:false});assert.equal(sent[0].e,'up');assert.equal(sent[1].t,'clipboard_paste');gate.reset();
});
test('modified, untrusted and unsupported pending Paste never become a plain native shortcut',()=>{
  for(const gesture of [{shiftKey:true},{altKey:true},{trusted:false},{metaKey:true}]) {
    const {gate,sent,key,reported}=pasteHarness();gate.begin('image-1');key('Control');key('v','down',{ctrlKey:true,...gesture});
    key('v','up');key('Control','up');gate.settle('image-1','applied',pasteToken);
    assert.equal(sent.length,2);assert.equal(reported[0].status,'rejected');gate.reset();
  }
  const {gate,key,sent,disable}=pasteHarness();gate.begin('image-1');disable();key('Control');key('v','down',{ctrlKey:true});
  key('v','up');key('Control','up');gate.settle('image-1','applied',pasteToken);assert.equal(sent.length,2);gate.reset();
});
test('focus/input/replacement/disconnect and failed or malformed acknowledgments cancel pending Paste',()=>{
  for(const cancel of [h=>h.gate.cancel('target_unavailable'),h=>h.key('x'),h=>h.gate.begin('newer'),
    h=>h.gate.reset(),h=>h.gate.settle('image-1','rejected',null),h=>h.gate.settle('image-1','applied','invalid'),
    h=>h.replaceConnection(),h=>h.gate.invalidate('cancelled')]) {
    const h=pasteHarness();h.gate.begin('image-1');h.key('Control');h.key('v','down',{ctrlKey:true});cancel(h);
    h.key('v','up');h.key('Control','up');h.gate.settle('image-1','applied',pasteToken);
    assert.equal(h.sent.filter(p=>p.t==='clipboard_paste').length,0);h.gate.reset();
  }
});
test('Paste results require exact action and clipboard ids and partial/timeout actions never retry',()=>{
  for(const timeout of [true,false]) {
    const h=pasteHarness();h.gate.begin('image-1');h.key('Control');h.key('v','down',{ctrlKey:true});
    h.key('v','up');h.key('Control','up');h.gate.settle('image-1','applied',pasteToken);
    const action=h.sent.at(-1);
    h.gate.consume({t:'clipboard_paste_result',id:action.id,clipboard_id:'wrong',status:'injected',reason:null});
    assert.equal(h.reported.length,0);
    if(timeout)[...h.timers.values()][0]();
    else h.gate.consume({t:'clipboard_paste_result',id:action.id,clipboard_id:'image-1',status:'uncertain',reason:'input_partial'});
    assert.equal(h.reported.at(-1).status,'uncertain');h.gate.flush();
    h.gate.consume({t:'clipboard_paste_result',id:action.id,clipboard_id:'image-1',status:'injected',reason:null});
    assert.equal(h.reported.length,1);assert.equal(h.sent.filter(p=>p.t==='clipboard_paste').length,1);h.gate.reset();
  }
});
