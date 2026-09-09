/* This Source Code Form is subject to the Mozilla Public License, v. 2.0.
 * https://mozilla.org/MPL/2.0/ */
import { postToCore } from './jolee-bridge.js';
const PCM_MIME = 'audio/pcm;format=s16le;rate=24000;channels=1';
let micGen = 0, micDeviceId = '', pcmSupported = false, current = null;
function release(owner) {
  if (!owner || owner.closed) return;
  owner.closed = true;
  if (owner.node) { owner.node.port.onmessage = null; owner.node.port.close(); owner.node.disconnect(); }
  owner.source?.disconnect();
  owner.stream?.getTracks().forEach(track => track.stop());
  if (owner.context) void owner.context.close().catch(() => {});
}
export function stopParentMicrophone() {
  micGen++;
  const owner = current; current = null;
  release(owner);
}
export function setParentMicFormats(formats) {
  pcmSupported = Array.isArray(formats) && formats.includes(PCM_MIME);
  return pcmSupported;
}
export function setParentMicDeviceId(deviceId) { micDeviceId = typeof deviceId === 'string' ? deviceId : ''; }
export function parentMicrophoneGeneration() { return micGen; }
export function isParentMicrophoneActive() { return !!current?.active && !current.closed; }
function fail(owner, error) {
  if (current !== owner || owner.gen !== micGen) { release(owner); return; }
  stopParentMicrophone();
  window.postMessage({ type: 'pipelineStatusUpdate', microphone: false,
    microphoneGeneration: micGen, error: error?.name || 'Microphone capture stopped' }, window.location.origin);
}
// Create/resume AudioContext inside the dashboard's trusted user gesture.
export async function startParentMicrophone() {
  if (!pcmSupported) return false;
  if (isParentMicrophoneActive()) return true;
  stopParentMicrophone();
  const owner = { gen: ++micGen, closed: false, active: false };
  current = owner;
  const alive = () => current === owner && owner.gen === micGen && !owner.closed && pcmSupported;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio || !navigator.mediaDevices?.getUserMedia) throw new Error('AudioWorklet capture unavailable');
    owner.context = new Audio();
    const resumed = owner.context.resume();
    void resumed.catch(() => {});
    const constraints = micDeviceId && micDeviceId !== 'default' ? { deviceId: { ideal: micDeviceId } } : true;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: constraints }); }
    catch (error) {
      if (!alive()) { release(owner); return false; }
      if (constraints !== true && ['OverconstrainedError','NotFoundError','NotReadableError'].includes(error?.name)) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else throw error;
    }
    if (!alive()) { stream.getTracks().forEach(track => track.stop()); release(owner); return false; }
    owner.stream = stream;
    await resumed;
    if (!alive()) { release(owner); return false; }
    await owner.context.audioWorklet.addModule('/mic-pcm-worklet.js?v=1');
    if (!alive()) { release(owner); return false; }
    owner.node = new AudioWorkletNode(owner.context, 'jolee-mic-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    owner.source = owner.context.createMediaStreamSource(stream);
    owner.node.onprocessorerror = error => fail(owner, error);
    owner.node.port.onmessage = event => {
      if (!alive()) return;
      const { buffer, sequence } = event.data || {};
      try {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 2400 || !Number.isSafeInteger(sequence) || sequence < 0) return;
        const data = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        postToCore({ type: 'micChunk', mime: PCM_MIME, sample_rate: 24000, channels: 1, sequence, data }, window.location.origin);
      } finally { if (alive()) owner.node.port.postMessage({ ack: sequence }); }
    };
    for (const track of stream.getTracks()) track.addEventListener('ended', () => fail(owner, new Error('Microphone ended')), { once: true });
    owner.source.connect(owner.node);
    // The worklet outputs silence; connection keeps audio processing scheduled.
    owner.node.connect(owner.context.destination);
    owner.active = true;
    return true;
  } catch (error) { fail(owner, error); return false; }
}
