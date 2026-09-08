const availabilityReasons = new Set(['unsupported', 'unauthorized', 'expired', 'unpaired',
  'policy_denied', 'policy_unreadable', 'service_required', 'session_unavailable',
  'session_changed', 'audit_unavailable', 'native_unavailable']);
const rejectCodes = new Set([...availabilityReasons, 'invalid_request', 'stale_generation',
  'id_conflict', 'rate_limited', 'busy', 'ledger_full', 'cancelled', 'preflight_unavailable']);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const generation = value => typeof value === 'string' && /^[0-9A-F]{32}$/.test(value);
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
const sessionId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

export function validSasCapability(value, session, now, expiresAt = null) {
  return exact(value, ['t', 'v', 'session_id', 'generation', 'expires_at', 'sas']) &&
    value.t === 'control_capabilities' && value.v === 1 && sessionId(value.session_id) &&
    value.session_id === session && generation(value.generation) &&
    Number.isSafeInteger(value.expires_at) && value.expires_at > now &&
    (expiresAt === null || value.expires_at <= expiresAt) && exact(value.sas, ['available', 'reason']) &&
    (value.sas.available === true && value.sas.reason === null ||
      value.sas.available === false && availabilityReasons.has(value.sas.reason));
}

export function validSasResult(value) {
  return exact(value, ['t', 'v', 'command', 'session_id', 'generation', 'id', 'status', 'code', 'effect']) &&
    value.t === 'command_result' && value.v === 1 && value.command === 'ctrl-alt-delete' &&
    sessionId(value.session_id) && generation(value.generation) && uuid(value.id) &&
    (value.status === 'rejected' && value.effect === 'not_attempted' && rejectCodes.has(value.code) ||
      value.status === 'invoked' && value.effect === 'unverified' && value.code === 'native_call_returned' ||
      value.status === 'uncertain' && value.effect === 'unverified' &&
        ['in_progress', 'native_outcome_unknown', 'audit_unavailable'].includes(value.code));
}

/** Ephemeral session/connection-bound requests. Never persist or replay commands. */
export class SasControl {
  constructor({ send, changed, report, now = Date.now, makeId = () => crypto.randomUUID(),
    schedule = (fn, delay) => setTimeout(fn, delay), unschedule = timer => clearTimeout(timer) }) {
    Object.assign(this, { send, changed, report, now, makeId, schedule, unschedule });
    this.connection = null; this.session = ''; this.capability = null; this.pending = null;
    this.expiryTimer = null; this.expiresAt = null; this.deadlines = new Map();
  }
  bind(connection, session, expiresAt = null) {
    if (connection === this.connection && session === this.session && expiresAt === this.expiresAt) return;
    this.invalidate();
    this.connection = connection; this.session = session; this.expiresAt = expiresAt; this.deadlines.clear();
    this.publish();
  }
  invalidate() {
    this.unschedule(this.expiryTimer); this.expiryTimer = null; this.capability = null;
    this.finish('uncertain');
  }
  finish(status) {
    if (!this.pending) return;
    this.unschedule(this.pending.timer); this.pending = null;
    this.publish(); this.report(status);
  }
  publish() {
    const available = !!(this.connection && this.capability?.sas.available && this.capability.expires_at > this.now());
    this.changed({ available: available && !this.pending, pending: !!this.pending,
      reason: this.pending ? 'pending' : available ? null : this.capability?.sas.reason || 'unsupported' });
  }
  armExpiry() {
    this.unschedule(this.expiryTimer);
    if (!this.capability) return;
    this.expiryTimer = this.schedule(() => {
      if (this.capability && this.capability.expires_at <= this.now()) { this.invalidate(); this.publish(); }
      else this.armExpiry();
    }, Math.min(2147483647, Math.max(1, this.capability.expires_at - this.now())));
  }
  consume(message, connection) {
    if (!message || !['control_capabilities', 'command_result'].includes(message.t)) return false;
    if (!connection || connection !== this.connection) return true;
    if (message.t === 'control_capabilities') {
      if (!validSasCapability(message, this.session, this.now(), this.expiresAt) ||
          (this.deadlines.has(message.generation) && this.deadlines.get(message.generation) !== message.expires_at ||
            !this.deadlines.has(message.generation) && this.deadlines.size >= 128)) {
        this.invalidate(); this.publish(); return true;
      }
      if (!message.sas.available || this.capability?.generation !== message.generation) this.finish('uncertain');
      this.deadlines.set(message.generation, message.expires_at);
      this.capability = structuredClone(message);
      this.armExpiry(); this.publish(); return true;
    }
    const p = this.pending;
    if (validSasResult(message) && p && p.connection === connection &&
        message.session_id === this.session && message.id === p.id && message.generation === p.generation) {
      if (this.now() >= p.deadline || this.now() >= this.capability.expires_at) this.finish('uncertain');
      else this.finish(message.status);
    }
    return true;
  }
  request() {
    const cap = this.capability;
    if (!this.connection || !cap?.sas.available || cap.expires_at <= this.now() || this.pending) {
      this.publish(); return false;
    }
    const id = this.makeId(); if (!uuid(id)) return false;
    const p = { id, generation: cap.generation, connection: this.connection, deadline: this.now() + 5000 };
    this.pending = p;
    p.timer = this.schedule(() => { if (this.pending === p) this.finish('uncertain'); }, 5000);
    this.publish();
    try {
      this.send({ t: 'command', v: 1, command: 'ctrl-alt-delete', id, generation: p.generation }, p.connection);
    } catch { this.finish('uncertain'); }
    return true;
  }
}
