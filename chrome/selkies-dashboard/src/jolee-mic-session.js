// Owns user intent separately from asynchronous browser capture requests.
export function createMicrophoneSession({ start, stop, select, changed, forward }) {
  let paired = false, supported = false, wanted = false, generation = 0;
  const eligible = () => paired && supported;
  function cancel(release = true) {
    generation++;
    const wasWanted = wanted;
    wanted = false;
    if (release) stop();
    changed(false, eligible());
    if (wasWanted) forward(false);
  }
  function update() {
    if (!eligible()) cancel();
    else changed(wanted, true);
  }
  async function begin(device) {
    if (!eligible()) return false;
    const request = ++generation;
    wanted = true;
    select(device);
    changed(true, true); // Keep Stop usable while permission is pending.
    let ok = false;
    try { ok = await start(); } catch { /* Capture failed. */ }
    if (request !== generation) return false;
    if (!ok) { cancel(false); return false; }
    if (!eligible()) { cancel(); return false; }
    forward(true);
    return true;
  }
  return {
    paired(value) { paired = value === true; if (!paired) supported = false; update(); },
    support(value) { supported = value === true; update(); },
    toggle(device) { if (wanted) { cancel(); return Promise.resolve(false); } return begin(device); },
    device(device) { const restart = wanted; cancel(); select(device); return restart ? begin(device) : Promise.resolve(false); },
    stop: () => cancel(),
    reset() { paired = supported = false; cancel(); },
  };
}
