// A confirmed display change is not usable until its new picture is painted.
export class DisplayTransition {
  constructor() { this.reset(); }
  reset() { this.id = null; this.state = 'idle'; }
  get blocked() { return this.state !== 'idle'; }
  begin(id) { this.id = id; this.state = 'pending'; }
  acknowledge(id) {
    if (id !== this.id || this.state !== 'pending') return false;
    this.state = 'frame'; return true;
  }
  fail(id) {
    if (id === this.id && this.state === 'pending') this.state = 'uncertain';
  }
  painted() {
    if (this.state !== 'frame') return false;
    this.reset(); return true;
  }
  allows(payload) {
    return !this.blocked || !['pointer','wheel','key','clipboard_paste','command'].includes(payload.t);
  }
}
