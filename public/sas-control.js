const availabilityReasons = new Set(['unsupported', 'unauthorized', 'expired', 'unpaired',
  'policy_denied', 'policy_unreadable', 'rdp_session_unsupported', 'service_required', 'session_unavailable',
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
const continuityCodes = {
  observing: ['helper_ready'], active: ['secure_frame_received'],
  warning: ['input_rejected', 'input_partial', 'input_unknown'],
  returned: ['normal_frame_received'],
  failed: ['prepare_failed', 'helper_lost', 'deadline_reached', 'session_changed',
    'capture_unavailable', 'return_unobserved', 'cancelled'],
};
export function validSecureDesktopStatus(value) {
  const keys=['t', 'v', 'session_id', 'generation', 'id', 'sequence', 'status', 'code'];
  if (value && Object.hasOwn(value,'secureExpiresAt')) {
    keys.push('secureExpiresAt');
    if (!Number.isSafeInteger(value.secureExpiresAt) || value.secureExpiresAt<=0) return false;
  }
  return exact(value, keys) &&
    value.t === 'secure_desktop_status' && value.v === 1 && sessionId(value.session_id) &&
    generation(value.generation) && uuid(value.id) && Number.isSafeInteger(value.sequence) &&
    value.sequence >= 1 && value.sequence <= 64 && typeof value.status === 'string' && typeof value.code === 'string' && Object.hasOwn(continuityCodes, value.status) &&
    continuityCodes[value.status].includes(value.code);
}

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
  constructor({ send, changed, report, secureReport = () => {}, secureActive = () => {}, now = Date.now, makeId = () => crypto.randomUUID(),
    schedule = (fn, delay) => setTimeout(fn, delay), unschedule = timer => clearTimeout(timer) }) {
    Object.assign(this, { send, changed, report, secureReport, secureActive, now, makeId, schedule, unschedule });
    this.connection = null; this.session = ''; this.capability = null; this.pending = null;
    this.expiryTimer = null; this.expiresAt = null; this.deadlines = new Map();
    this.observations = new Map();
  }
  bind(connection, session, expiresAt = null) {
    if (connection === this.connection && session === this.session && expiresAt === this.expiresAt) return;
    this.invalidate();
    this.connection = connection; this.session = session; this.expiresAt = expiresAt; this.deadlines.clear();
    this.publish();
  }
  invalidate() {
    this.pruneObservations();
    this.unschedule(this.observationTimer); this.observationTimer=null;
    this.unschedule(this.expiryTimer); this.expiryTimer = null; this.capability = null;
    this.observations.clear();
    this.publishSecureActive();
    this.finish('uncertain');
  }
  pruneObservations() {
    for (const [id, entry] of this.observations) if (entry.deadline <= this.now()) {
      this.observations.delete(id);
      if (entry.secureExpiry && !entry.terminal) this.secureReport({status:'failed',code:'deadline_reached'});
    }
    this.publishSecureActive();
  }
  publishSecureActive() {
    this.secureActive([...this.observations.values()].some(entry => entry.active && !entry.terminal));
  }
  armObservationExpiry() {
    this.publishSecureActive();
    this.unschedule(this.observationTimer);
    const deadlines=[...this.observations.values()].filter(e=>!e.terminal).map(e=>e.deadline);
    if (!deadlines.length) return;
    this.observationTimer=this.schedule(()=>{this.pruneObservations();this.armObservationExpiry();},
      Math.max(1,Math.min(...deadlines)-this.now()));
  }
  finish(status) {
    if (!this.pending) return;
    this.unschedule(this.pending.timer); this.pending = null;
    this.publish(); this.report(status);
  }
  publish() {
    this.pruneObservations();
    const available = !!(this.connection && this.capability?.sas.available && this.capability.expires_at > this.now() && this.observations.size < 128);
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
    if (!message || !['control_capabilities', 'command_result', 'secure_desktop_status'].includes(message.t)) return false;
    if (!connection || connection !== this.connection) return true;
    if (message.t === 'secure_desktop_status') {
      this.pruneObservations();
      if (!validSecureDesktopStatus(message)) return true;
      const entry = this.observations.get(message.id);
      if (!entry || entry.terminal || entry.connection !== connection || message.session_id !== this.session ||
          entry.generation !== message.generation || this.capability?.generation !== message.generation ||
          message.sequence <= entry.sequence || message.status === 'observing' && entry.active) return true;
      if (Object.hasOwn(message,'secureExpiresAt')) {
        if (message.secureExpiresAt>entry.grantDeadline || message.secureExpiresAt>entry.startedAt+3600000 ||
            entry.secureExpiry && entry.secureExpiry!==message.secureExpiresAt) return true;
        entry.secureExpiry=message.secureExpiresAt;entry.deadline=message.secureExpiresAt;
        this.pruneObservations();this.armObservationExpiry();
        if (!this.observations.has(message.id)) return true;
      }
      entry.sequence = message.sequence;
      if (message.status === 'active') entry.active = true;
      if (message.status === 'returned' || message.status === 'failed') entry.terminal = true;
      this.armObservationExpiry();
      if (['warning', 'returned', 'failed'].includes(message.status) && !entry.reported.has(message.code)) {
        entry.reported.add(message.code);
        this.secureReport({ status: message.status, code: message.code });
      }
      return true;
    }
    if (message.t === 'control_capabilities') {
      if (!validSasCapability(message, this.session, this.now(), this.expiresAt) ||
          (this.deadlines.has(message.generation) && this.deadlines.get(message.generation) !== message.expires_at ||
            !this.deadlines.has(message.generation) && this.deadlines.size >= 128)) {
        this.invalidate(); this.publish(); return true;
      }
      if (this.capability?.generation !== message.generation) { this.observations.clear(); this.publishSecureActive(); }
      // Availability controls new requests, not the outcome of an already admitted request.
      // Secure-desktop preparation temporarily makes the same generation unavailable.
      if (this.capability?.generation !== message.generation) this.finish('uncertain');
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
    this.pruneObservations();
    const cap = this.capability;
    if (!this.connection || !cap?.sas.available || cap.expires_at <= this.now() || this.pending || this.observations.size >= 128) {
      this.publish(); return false;
    }
    const id = this.makeId(); if (!uuid(id) || this.observations.has(id)) return false;
    const p = { id, generation: cap.generation, connection: this.connection, deadline: this.now() + 5000 };
    this.observations.set(id, { connection: this.connection, generation: cap.generation,
      startedAt:this.now(),grantDeadline:cap.expires_at,secureExpiry:null,
      deadline: Math.min(this.now() + 45000, cap.expires_at), sequence: 0, active: false, terminal: false, reported: new Set() });
    this.armObservationExpiry();
    this.pending = p;
    p.timer = this.schedule(() => { if (this.pending === p) this.finish('uncertain'); }, 5000);
    this.publish();
    try {
      this.send({ t: 'command', v: 1, command: 'ctrl-alt-delete', id, generation: p.generation }, p.connection);
    } catch { this.finish('uncertain'); }
    return true;
  }
}
