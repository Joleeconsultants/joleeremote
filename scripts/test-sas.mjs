import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SasControl, validSasCapability, validSasResult } from '../public/sas-control.js';

const gen = 'A'.repeat(32), otherGen = 'B'.repeat(32);
const id = '12345678-1234-4123-8123-123456789abc';
const capability = (extra = {}) => ({ t: 'control_capabilities', v: 1, session_id: 'session',
  generation: gen, expires_at: 10000, sas: { available: true, reason: null }, ...extra });
const result = (extra = {}) => ({ t: 'command_result', v: 1, command: 'ctrl-alt-delete',
  session_id: 'session', generation: gen, id, status: 'invoked', code: 'native_call_returned', effect: 'unverified', ...extra });
function harness() {
  let clock = 1000, nextTimer = 0;
  const timers = new Map(), sent = [], states = [], reports = [], connection = {};
  const control = new SasControl({ send: (m, c) => sent.push({ m, c }), changed: s => states.push(s),
    report: s => reports.push(s), now: () => clock, makeId: () => id,
    schedule: (fn, delay) => { const key = ++nextTimer; timers.set(key, { fn, at: clock + delay }); return key; },
    unschedule: key => timers.delete(key) });
  control.bind(connection, 'session', 10000);
  return { control, connection, sent, states, reports, timers,
    advance(ms) { clock += ms; for (const [key, task] of [...timers]) if (task.at <= clock) { timers.delete(key); task.fn(); } },
    jump(ms) { clock += ms; } };
}

test('capability requires exact schema, session, generation, state and immutable deadline', () => {
  assert.equal(validSasCapability(capability(), 'session', 1000, 10000), true);
  for (const key of Object.keys(capability())) { const c = capability(); delete c[key]; assert.equal(validSasCapability(c, 'session', 1000), false); }
  for (const change of [{ extra: 1 }, { v: 2 }, { session_id: 'other' }, { session_id: [] }, { generation: gen.toLowerCase() },
    { generation: 'A'.repeat(31) }, { expires_at: '10000' }, { expires_at: 10000.5 }, { expires_at: Infinity },
    { expires_at: 1000 }, { sas: { available: true, reason: 'unsupported' } }, { sas: { available: 1, reason: null } },
    { sas: { available: false, reason: 'arbitrary' } }, { sas: { available: true, reason: null, extra: 1 } }])
    assert.equal(validSasCapability(capability(change), 'session', 1000), false, JSON.stringify(change));
  assert.equal(validSasCapability(capability(), 'session', 1000, 9999), false);
  assert.equal(validSasCapability(capability({ sas: { available: false, reason: 'policy_denied' } }), 'session', 1000), true);
});

test('results accept only the agreed status/code/effect combinations and exact schema', () => {
  assert.equal(validSasResult(result()), true);
  for (const key of Object.keys(result())) { const r = result(); delete r[key]; assert.equal(validSasResult(r), false); }
  for (const status of ['rejected', 'invoked', 'uncertain', 'success']) for (const effect of ['not_attempted', 'unverified', 'applied']) {
    const code = status === 'rejected' ? 'policy_denied' : status === 'uncertain' ? 'in_progress' : 'native_call_returned';
    assert.equal(validSasResult(result({ status, code, effect })), status === 'rejected' && effect === 'not_attempted' ||
      ['invoked', 'uncertain'].includes(status) && effect === 'unverified');
  }
  for (const change of [{ extra: 1 }, { v: 2 }, { command: 'other' }, { id: id.toUpperCase() },
    { id: '00000000-0000-0000-0000-000000000000' }, { generation: gen.toLowerCase() },
    { code: 'arbitrary' }, { session_id: [] }]) assert.equal(validSasResult(result(change)), false);
});

test('one explicit click sends one exact request; no capability, unavailable or pending sends none', () => {
  const h = harness(); assert.equal(h.control.request(), false);
  h.control.consume(capability({ sas: { available: false, reason: 'unsupported' } }), h.connection);
  assert.equal(h.control.request(), false);
  h.control.consume(capability(), h.connection); assert.equal(h.states.at(-1).available, true);
  assert.equal(h.control.request(), true); assert.equal(h.control.request(), false);
  assert.deepEqual(h.sent, [{ c: h.connection, m: { t: 'command', v: 1, command: 'ctrl-alt-delete', id, generation: gen } }]);
  assert.equal(h.states.at(-1).pending, true);
  h.control.consume(result(), h.connection);
  assert.deepEqual(h.reports, ['invoked']); assert.equal(h.states.at(-1).available, true);
});

test('wrong session, request, generation and connection cannot resolve a pending request', () => {
  const h = harness(); h.control.consume(capability(), h.connection); h.control.request();
  for (const change of [{ session_id: 'other' }, { id: '22345678-1234-4123-8123-123456789abc' },
    { generation: otherGen }, { effect: 'applied' }]) h.control.consume(result(change), h.connection);
  h.control.consume(result(), {}); assert.deepEqual(h.reports, []);
  h.control.consume(result(), h.connection); assert.deepEqual(h.reports, ['invoked']);
});

test('timeout and late results never replay or claim completion', () => {
  const h = harness(); h.control.consume(capability(), h.connection); h.control.request(); h.advance(5000);
  assert.deepEqual(h.reports, ['uncertain']); h.control.consume(result(), h.connection);
  assert.deepEqual(h.reports, ['uncertain']); assert.equal(h.sent.length, 1);
  assert.equal(h.states.at(-1).pending, false);
});

test('disconnect, generation change, malformed/lost capability and expiry retire pending state', () => {
  for (const transition of [h => h.control.bind(null, 'session'),
    h => h.control.consume(capability({ generation: otherGen }), h.connection),
    h => h.control.consume(capability({ sas: { available: false, reason: 'unpaired' } }), h.connection),
    h => h.control.consume(capability({ extra: true }), h.connection), h => h.advance(9000)]) {
    const h = harness(); h.control.consume(capability(), h.connection); h.control.request(); transition(h);
    assert.deepEqual(h.reports, ['uncertain']); h.control.consume(result(), h.connection);
    assert.deepEqual(h.reports, ['uncertain']); assert.equal(h.sent.length, 1); assert.equal(h.control.pending, null);
  }
});

test('same-generation updates cannot extend expiry; delayed browser timers do not admit expired results', () => {
  const h = harness(); h.control.consume(capability(), h.connection);
  h.control.consume(capability({ expires_at: 9999 }), h.connection); assert.equal(h.control.request(), false);
  h.control.consume(capability({ expires_at: 9999 }), h.connection); assert.equal(h.control.request(), false);
  h.control.consume(capability({ extra: true }), h.connection);
  h.control.consume(capability({ expires_at: 9999 }), h.connection); assert.equal(h.control.request(), false);
  h.control.consume(capability(), h.connection); h.control.request(); h.jump(5001);
  h.control.consume(result(), h.connection); assert.deepEqual(h.reports, ['uncertain']);
});

test('connection replacement and reload carry neither capability nor pending requests', () => {
  const h = harness(); h.control.consume(capability(), h.connection); h.control.request();
  const next = {}; h.control.bind(next, 'session', 10000);
  h.control.consume(capability(), h.connection); assert.equal(h.control.request(), false);
  h.control.consume(result(), h.connection); assert.deepEqual(h.reports, ['uncertain']);
  h.control.consume(capability({ generation: otherGen }), next); assert.equal(h.control.request(), true);
  h.control.consume(result(), next); assert.equal(h.control.pending.generation, otherGen);
  assert.equal(harness().control.request(), false);
});

test('uncertain native result or send failure never retries automatically', () => {
  const h = harness(); h.control.consume(capability(), h.connection); h.control.request();
  h.control.consume(result({ status: 'uncertain', code: 'audit_unavailable' }), h.connection);
  assert.deepEqual(h.reports, ['uncertain']); h.advance(5000); assert.equal(h.sent.length, 1);
  const failed = harness(); failed.control.consume(capability(), failed.connection);
  failed.control.send = () => { throw Error('transport failed'); }; failed.control.request();
  assert.deepEqual(failed.reports, ['uncertain']); assert.equal(failed.control.pending, null);
});
