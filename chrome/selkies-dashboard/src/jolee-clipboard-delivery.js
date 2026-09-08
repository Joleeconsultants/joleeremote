/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Latest-value clipboard delivery. Invoke flush directly in a real gesture.
 * Browser writes cannot be cancelled once submitted, so serialize them and
 * discard stale completions instead of allowing older writes to finish last.
 * Permission rejection retains one value until a gesture, replacement or reset.
 */
export function createClipboardDelivery({ write, report, enabled }) {
  let sequence = 0, pending = null, running = null, active = null;
  function clear() { sequence++; pending = null; }
  function clearImages() {
    const latest = pending || active;
    if (latest && typeof latest.blob !== 'string') clear();
  }
  function flush() {
    if (running || !pending) return running;
    if (!enabled(pending.blob)) { clear(); return null; }
    const entry = pending;
    pending = null; active = entry;
    // Call before the first await: Safari needs the current user activation.
    let attempt;
    try { attempt = write(entry.blob); } catch (error) { attempt = Promise.reject(error); }
    running = Promise.resolve(attempt).then(() => {
      if (entry.sequence === sequence && enabled(entry.blob)) report('applied');
    }, error => {
      if (entry.sequence !== sequence || !enabled(entry.blob)) return;
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        pending = entry;
        if (!entry.reported) { entry.reported = true; report('gesture_required'); }
      } else report('failed');
    }).finally(() => {
      running = null; active = null;
      // A newer value arrived during this write. Never automatically retry
      // the same permission failure in a loop.
      if (pending && pending.sequence !== entry.sequence) flush();
    });
    return running;
  }
  function receive(blob) {
    if (!enabled(blob)) { clear(); return null; }
    pending = { blob, sequence: ++sequence, reported: false };
    return flush();
  }
  return { receive, flush, clear, clearImages };
}

/** Defense in depth for the same-origin core's already preflighted PNG. */
export function clipboardImageBlob(message) {
  if (message.mime !== 'image/png' || typeof message.data !== 'string' ||
      !message.data.length || message.data.length > 1024000 || message.data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw new Error('Invalid clipboard image');
  const binary = atob(message.data);
  if (btoa(binary) !== message.data || binary.length > 768000) throw new Error('Invalid clipboard image');
  return new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))], { type: 'image/png' });
}
