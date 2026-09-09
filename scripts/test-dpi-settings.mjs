import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSetDpi, initialDpi, filterDpiSetting } from '../chrome/selkies-dashboard/src/jolee-dpi-settings.js';
import { debounceSettings } from '../chrome/selkies-dashboard/src/jolee-bridge.js';

const setting = { value: '96', allowed: ['96', '120', '144'], locked: false, overridden: false };

test('startup waits for confirmed capability, including when it arrives after settings', () => {
  for (const capability of [undefined, false, 'true'])
    assert.equal(initialDpi(setting, NaN, 144, capability).post, null);
  assert.equal(initialDpi(setting, NaN, 144, true).post, 144);
  assert.equal(initialDpi(setting, NaN, 96, true).post, null);
  assert.equal(initialDpi(undefined, NaN, 144, true), null);
});

test('stored and operator choices preserve original precedence without a derived write', () => {
  assert.deepEqual(initialDpi(setting, 120, 144, true), { value: 120, post: null });
  for (const policy of ['locked', 'overridden'])
    assert.deepEqual(initialDpi({ ...setting, [policy]: true }, 120, 144, true), { value: 96, post: null });
});

test('reset and explicit writes require writable advertised integer DPI', () => {
  assert.equal(canSetDpi(setting, true, 120), true);
  for (const value of [NaN, 120.5, '120', 192]) assert.equal(canSetDpi(setting, true, value), false);
  for (const policy of [undefined, { ...setting, locked: true }, { ...setting, overridden: true }])
    assert.equal(canSetDpi(policy, true, 120), false);
  for (const capability of [undefined, false]) assert.equal(canSetDpi(setting, capability, 120), false);
  assert.equal(initialDpi(setting, NaN, 192, true).post, null);
});

test('capability loss during a real debounce drops DPI but delivers other pending controls', async () => {
  const messages = [];
  let supported = true;
  const enqueue = debounceSettings(settings => {
    const filtered = filterDpiSetting(settings, setting, supported);
    if (Object.keys(filtered).length) messages.push(filtered);
  }, 5);
  enqueue({ scaling_dpi: 144 });
  enqueue({ framerate: 8 });
  supported = false;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(messages, [{ framerate: 8 }]);
  enqueue({ scaling_dpi: 120 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(messages.length, 1);
  enqueue.cancel();
});

test('flush also honors newly locked settings without mutating the pending batch', () => {
  const batch = { scaling_dpi: 144, audio_bitrate: 128000 };
  assert.deepEqual(filterDpiSetting(batch, { ...setting, locked: true }, true), { audio_bitrate: 128000 });
  assert.equal(batch.scaling_dpi, 144);
  assert.deepEqual(filterDpiSetting(batch, setting, true), batch);
});
