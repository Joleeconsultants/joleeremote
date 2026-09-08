/** A pending clipboard write may delay only an explicit, plain Paste gesture.
 * Key releases still flow normally. A native one-use action replaces replay of
 * a partially held shortcut; its result means injected, never target completion.
 */
export class ClipboardPasteGate {
  constructor({ send, report, supported, connection, uuid = () => crypto.randomUUID(),
    schedule = setTimeout, unschedule = clearTimeout }) {
    Object.assign(this, { send, report, supported, connection, uuid, schedule, unschedule });
    this.held = new Map(); this.suppressed = new Set();
    this.write = null; this.intent = null; this.action = null;
  }
  begin(id) {
    this.cancel('superseded');
    this.write = { id, state: 'pending', connection: this.connection() };
  }
  settle(id, status, token) {
    if (this.write?.id !== id) return;
    this.write.state = status;
    this.write.token = typeof token === 'string' && /^[0-9a-f]{32}$/i.test(token) ? token : null;
    if (this.intent && (status !== 'applied' || !this.write.token)) this.cancel('clipboard_unconfirmed');
    this.flush();
  }
  cancel(reason = 'cancelled') {
    if (!this.intent) return;
    this.unschedule(this.intent.timer); this.intent = null;
    this.report('rejected', reason);
  }
  invalidate(reason = 'cancelled') { this.cancel(reason); this.write = null; }
  reset() {
    this.invalidate('session_unavailable');
    if (this.action) this.unschedule(this.action.timer);
    this.action = null; this.held.clear(); this.suppressed.clear();
  }
  key(payload, gesture = {}) {
    const key = (payload.key || '').toLowerCase(), code = payload.code || key;
    if (payload.e === 'up') this.held.delete(code); else this.held.set(code, key);
    // Focus can enter the canvas after Ctrl/Cmd was pressed elsewhere. The
    // trusted event's modifier flags still prevent dispatch before release.
    for (const [flag, name] of [['ctrlKey', 'control'], ['metaKey', 'meta'], ['shiftKey', 'shift'], ['altKey', 'alt']]) {
      if (typeof gesture[flag] === 'boolean') {
        if (gesture[flag]) this.held.set(`@${name}`, name); else this.held.delete(`@${name}`);
      } else if (key === name && payload.e === 'up') this.held.delete(`@${name}`);
    }
    if (this.suppressed.has(code)) {
      if (payload.e === 'up') this.suppressed.delete(code);
      this.flush(); return;
    }
    const paste = key === 'v' || payload.code === 'KeyV';
    const control = gesture.ctrlKey || [...this.held.values()].includes('control');
    const meta = gesture.metaKey || [...this.held.values()].includes('meta');
    if (payload.e === 'down' && paste && (control || meta) && this.write?.state === 'pending') {
      this.suppressed.add(code);
      const modified = gesture.shiftKey || gesture.altKey || (control && meta) ||
        [...this.held.values()].some(k => k === 'shift' || k === 'alt');
      if (this.action) { this.report('rejected', 'input_unavailable'); return; }
      if (!gesture.trusted || modified || !this.supported()) {
        this.report('rejected', modified ? 'modified_shortcut' : 'unsupported'); return;
      }
      this.cancel('superseded');
      const intent = { id: this.uuid(), clipboard_id: this.write.id };
      intent.timer = this.schedule(() => { if (this.intent === intent) this.cancel('confirmation_timeout'); }, 15000);
      this.intent = intent;
      return;
    }
    if (payload.e === 'down' && this.intent) this.cancel('conflicting_input');
    this.send(payload); // Especially modifier releases, before dispatching Paste.
    this.flush();
  }
  flush() {
    const intent = this.intent, write = this.write;
    if (!intent || !write || write.state !== 'applied' || this.action) return;
    if (!write.connection || write.connection !== this.connection()) { this.invalidate('session_unavailable'); return; }
    if ([...this.held.values()].some(k => ['control', 'shift', 'alt', 'meta', 'v'].includes(k))) return;
    this.unschedule(intent.timer); this.intent = null;
    if (!write.token || !this.supported()) { this.report('rejected', 'unsupported'); return; }
    const token = write.token; write.token = null;
    const action = { ...intent };
    action.timer = this.schedule(() => {
      if (this.action !== action) return;
      this.action = null; this.report('uncertain', 'confirmation_timeout');
    }, 10000);
    this.action = action;
    this.send({ t: 'clipboard_paste', id: action.id, clipboard_id: action.clipboard_id, paste_token: token });
  }
  consume(result) {
    if (result?.t !== 'clipboard_paste_result') return false;
    if (!this.action || result.id !== this.action.id || result.clipboard_id !== this.action.clipboard_id) return true;
    const reasons = ['unsupported', 'invalid_request', 'superseded', 'clipboard_unavailable', 'modifiers_active',
      'target_unavailable', 'input_unavailable', 'already_consumed'];
    const valid = result.status === 'injected' && result.reason === null ||
      result.status === 'rejected' && reasons.includes(result.reason) ||
      result.status === 'uncertain' && result.reason === 'input_partial';
    if (!valid) return true;
    this.unschedule(this.action.timer); this.action = null;
    this.report(result.status, result.reason);
    return true;
  }
}
