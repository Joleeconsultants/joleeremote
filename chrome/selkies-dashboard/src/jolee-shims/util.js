/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Original Jolee replacements for dashboard util imports. Not selkies-web-core.
 * @module
 */

const LABELS = {
  websockets: "WebSockets",
  webrtc: "WebRTC",
  h264enc: "H.264",
  "h264enc-striped": "H.264 (striped)",
  jpeg: "JPEG",
  cbr: "CBR",
  crf: "CRF",
  auto: "Auto",
  h264: "H.264",
  vp8: "VP8",
  mjpeg: "MJPEG",
};

export const displayLabel = (value) => LABELS[value] ?? value;

export const decodableEncoders = (encoders) =>
  (encoders || []).filter(
    (encoder) => encoder === "jpeg" || typeof VideoDecoder !== "undefined",
  );

let fullColorProbe = null;

export function canDecodeFullColor() {
  if (!fullColorProbe) {
    fullColorProbe = (async () => {
      if (typeof VideoDecoder === "undefined") return false;
      try {
        const support = await VideoDecoder.isConfigSupported({
          codec: "avc1.F4001E",
          codedWidth: 320,
          codedHeight: 240,
        });
        return !!(support && support.supported);
      } catch {
        return false;
      }
    })();
  }
  return fullColorProbe;
}

export function getRoutePrefix() {
  const pathname = window.location.pathname;
  const dirPath = pathname.substring(0, pathname.lastIndexOf("/") + 1);
  return dirPath.replace(/\/$/, "");
}

/**
 * Stable localStorage app prefix for chrome settings.
 * Must NOT include session id, query, or hash — those change every mint/refresh
 * under UI_PREVIEW and would make prefs look randomly forgotten.
 * Prefer a fixed product id; fall back to legacy origin+path keys on read
 * via migrateLegacyStorageKey in Sidebar when present.
 */
export function getStorageAppName() {
  return "jolee-remote";
}

/** Pre-stabilization prefix (origin + pathname). Used only to migrate old keys. */
export function getLegacyStorageAppName() {
  if (typeof window === "undefined") return "jolee-remote";
  return (window.location.origin + window.location.pathname).replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
}

export const isMobileClient =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;
