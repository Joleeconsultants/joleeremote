import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMicrophoneSession } from '../chrome/selkies-dashboard/src/jolee-mic-session.js';

function fixture() {
  const requests = [], forwards = [], states = [], devices = [];
  let stops = 0;
  const session = createMicrophoneSession({
    start: () => new Promise(resolve => requests.push(resolve)), stop: () => stops++,
    select: id => devices.push(id), changed: (active, ready) => states.push({ active, ready }),
    forward: value => forwards.push(value),
  });
  return { session, requests, forwards, states, devices, get stops() { return stops; },
    ready() { session.paired(true); session.support(true); } };
}
test('microphone needs both a paired session and confirmed support', async () => {
  const f = fixture();
  await f.session.toggle('default'); f.session.support(true); await f.session.toggle('default');
  assert.equal(f.requests.length, 0);
  f.session.paired(false); f.session.paired(true); await f.session.toggle('default');
  assert.equal(f.requests.length, 0);
  f.session.support(true); const start = f.session.toggle('default');
  f.requests[0](true); assert.equal(await start, true); assert.deepEqual(f.forwards, [true]);
});
for (const reason of ['disconnect', 'unsupported', 'stale', 'reload']) {
  test(`${reason} cancels pending permission without enabling forwarding`, async () => {
    const f = fixture(); f.ready(); const pending = f.session.toggle('default');
    const before = f.stops;
    if (reason === 'disconnect') f.session.paired(false);
    else if (reason === 'reload') f.session.reset();
    else f.session.support(reason === 'stale' ? null : false);
    assert.ok(f.stops > before); f.requests[0](true); assert.equal(await pending, false);
    assert.deepEqual(f.states.at(-1), { active: false, ready: false });
    assert.ok(!f.forwards.includes(true));
  });
}
test('stop remains usable while permission is pending; old failure cannot cancel a new selection', async () => {
  const f = fixture(); f.ready(); const old = f.session.toggle('first');
  await f.session.toggle('first'); const current = f.session.toggle('second');
  f.requests[1](true); assert.equal(await current, true);
  f.requests[0](false); assert.equal(await old, false);
  assert.deepEqual(f.states.at(-1), { active: true, ready: true });
  assert.equal(f.forwards.at(-1), true);
});
test('device changes supersede capture and cannot restart after disconnect', async () => {
  const f = fixture(); f.ready(); const old = f.session.toggle('first');
  const next = f.session.device('second'); f.requests[0](true); assert.equal(await old, false);
  f.session.paired(false); f.requests[1](true); assert.equal(await next, false);
  assert.ok(!f.forwards.includes(true)); assert.equal(f.devices.at(-1), 'second');
});
test('capability refresh does not restart capture, and recovery needs a user gesture', async () => {
  const f = fixture(); f.ready(); const pending = f.session.toggle('default');
  f.requests[0](true); await pending;
  f.ready(); assert.equal(f.requests.length, 1);
  f.session.support(null); assert.equal(f.forwards.at(-1), false);
  f.session.support(true); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.states.at(-1), { active: false, ready: true });
});
