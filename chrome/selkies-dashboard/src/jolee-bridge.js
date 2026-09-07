/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Posts dashboard commands to the Jolee Remote hop core iframe instead of
 * same-window selkies-core. Original Jolee glue; not copied from Selkies.
 * requestFullscreen runs on the parent iframe in the same tick as the click
 * so user activation is not lost; other messages post into the iframe.
 * @param {object} message
 * @param {string} [targetOrigin]
 */
const settingsByFrame = new WeakMap();

/** Coalesce slider bursts by key, so adjusting another control loses no values. */
export function debounceSettings(send, delay) {
  let timer;
  let pending = {};
  const enqueue = (settings) => {
    Object.assign(pending, settings);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const settings = pending;
      pending = {};
      send(settings);
    }, delay);
  };
  enqueue.cancel = () => { clearTimeout(timer); pending = {}; };
  return enqueue;
}

export function postToCore(message, targetOrigin = window.location.origin) {
  const iframe = document.getElementById("jolee-core");
  if (iframe && message?.type === "settings") {
    let state = settingsByFrame.get(iframe);
    if (!state) {
      state = { settings: {}, origin: targetOrigin };
      settingsByFrame.set(iframe, state);
      // Initial React effects may run before the core's message listener exists.
      // Replay settings only; input and actions must never replay on load.
      iframe.addEventListener("load", () => iframe.contentWindow?.postMessage(
        { type: "settings", settings: state.settings }, state.origin));
    }
    Object.assign(state.settings, message.settings);
    state.origin = targetOrigin;
  }
  if (message && message.type === "requestFullscreen" && iframe) {
    const req = iframe.requestFullscreen || iframe.webkitRequestFullscreen;
    if (req) {
      Promise.resolve(req.call(iframe)).catch(() => {
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage(message, targetOrigin);
        }
      });
      return;
    }
  }
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage(message, targetOrigin);
    return;
  }
  window.postMessage(message, targetOrigin);
}
