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
const source = html.slice(html.indexOf('function handlePrintFrame(pf){'), html.indexOf('function applyAudioSink(el){'));
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
    MAX_ENVELOPE_BYTES:1048576, encodeInput:JSON.stringify});
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
  const c = vm.createContext({ performance: { now: () => now },
    window: { parent: { postMessage: value => sent.push(value) }, location: { origin: 'https://test.invalid' } },
    frameCount: 0, statsStartedAt: 0, bytesSinceStats: 0, hopFps: 0, hopBandwidth: 0, agentStats: {}, agentStatsReceivedAt: 0, latencyReading: () => null });
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
  const c = vm.createContext({ performance: { now: () => now }, crypto: { randomUUID: () => `nonce-${++nonce}` },
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
