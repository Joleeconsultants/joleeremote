import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { microphoneErrorMessage, listAudioDevices } from '../chrome/selkies-dashboard/src/jolee-bridge.js';

test('microphone errors identify local browser capture problems without exposing raw errors',()=>{
  assert.match(microphoneErrorMessage('NotFoundError'),/this browser/);
  assert.match(microphoneErrorMessage('NotAllowedError'),/Allow microphone access/);
  assert.match(microphoneErrorMessage('NotReadableError'),/another app/);
  assert.doesNotMatch(microphoneErrorMessage('secret arbitrary message'),/secret/);
});
test('device changes enumerate without activating or requesting microphone access',async()=>{
  const devices=[{kind:'audiooutput',deviceId:'default',label:''}];
  let captures=0;
  assert.deepEqual(await listAudioDevices({enumerateDevices:async()=>devices,getUserMedia:()=>{captures++;}},false),devices);
  assert.equal(captures,0);
});

function fixture() {
  const requests = [];
  const source = readFileSync(new URL('../chrome/selkies-dashboard/src/jolee-mic-capture.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/m, '').replaceAll('export function ', 'function ').replaceAll('export async function ', 'async function ');
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    addEventListener() {}
  }
  const context = vm.createContext({ navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) } },
    MediaRecorder: Recorder, console: { warn() {}, error() {} }, window: { location: { origin: 'https://fixture.invalid' }, postMessage() {} }, postToCore() {} });
  vm.runInContext(source, context);
  return { requests, start: context.startParentMicrophone, stop: context.stopParentMicrophone, select: context.setParentMicDeviceId };
}
function stream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, getTracks: () => [track] };
}
test('superseded microphone completion cannot orphan the newer active stream', async () => {
  const f = fixture();
  const first = f.start(); f.stop(); const second = f.start();
  const current = stream(); f.requests[1].resolve(current); assert.equal(await second, true);
  const stale = stream(); f.requests[0].resolve(stale); assert.equal(await first, false);
  assert.equal(stale.track.stopped, true); assert.equal(current.track.stopped, false);
  f.stop(); assert.equal(current.track.stopped, true);
});
test('stopped microphone request does not retry a fallback capture', async () => {
  const f = fixture(); f.select('selected-device');
  const pending = f.start(); f.stop();
  f.requests[0].reject(Object.assign(new Error('missing'), { name: 'NotFoundError' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
  assert.equal(await pending, false);
});
test('stopping while permission is pending releases the eventual stream', async () => {
  const f = fixture(); const pending = f.start(); f.stop();
  const stale = stream(); f.requests[0].resolve(stale);
  assert.equal(await pending, false); assert.equal(stale.track.stopped, true);
});
test('current device failure still falls back and releases the successful stream on stop', async () => {
  const f = fixture(); f.select('missing-device'); const pending = f.start();
  f.requests[0].reject(Object.assign(new Error('missing'), { name: 'NotFoundError' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 2);
  const current = stream(); f.requests[1].resolve(current);
  assert.equal(await pending, true); f.stop(); assert.equal(current.track.stopped, true);
});
test('already pending fallback cannot replace a newer stream after cancellation', async () => {
  const f = fixture(); f.select('missing-device'); const first = f.start();
  f.requests[0].reject(Object.assign(new Error('missing'), { name: 'NotFoundError' }));
  await new Promise(resolve => setImmediate(resolve));
  f.stop(); const second = f.start();
  const current = stream(); f.requests[2].resolve(current); assert.equal(await second, true);
  const stale = stream(); f.requests[1].resolve(stale); assert.equal(await first, false);
  assert.equal(stale.track.stopped, true); assert.equal(current.track.stopped, false);
  f.stop(); assert.equal(current.track.stopped, true);
});


test('deferred viewer refuses pilot microphone enable before acquiring resources',()=>{
 const html=readFileSync(new URL('../public/viewer.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('function setMicrophoneForwarding('),html.indexOf('async function setMicrophoneEnabled('));
 let cleared=0;
 const c=vm.createContext({microphoneFeatureEnabled:false,microphoneForwarding:false,clearMicrophoneResources(){cleared++;}});
 vm.runInContext(source,c);c.setMicrophoneForwarding(true);
 assert.equal(c.microphoneForwarding,false);assert.equal(cleared,1);
 assert.match(html,/const microphoneFeatureEnabled=true/);
});
