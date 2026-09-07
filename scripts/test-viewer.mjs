import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
