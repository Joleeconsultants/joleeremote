/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Original conditional-setting specs so the vendored sidebar still compiles.
 * Not copied from selkies-web-core. Encoder specs still post settings
 * messages (hop forwards `settings`; no pixelflux). Gaming stays noop.
 * @module
 */

export function resolveSpec(spec, serverSettings, ctx, readStored) {
  const server = serverSettings ? serverSettings[spec.serverKey] : undefined;
  const stored = readStored(spec.storageKey);
  const parse = spec.parse || ((v) => v);
  const usable = (v) => v !== undefined && v !== null && (!spec.isValid || spec.isValid(v, ctx));
  let raw;
  if (server && server.locked) raw = server.value;
  else if (stored !== null && stored !== undefined) {
    const v = parse(stored);
    if (usable(v)) raw = v;
  }
  if (raw === undefined && spec.conditional) {
    const derived = spec.conditional(ctx);
    if (usable(derived)) raw = derived;
  }
  if (raw === undefined && server) raw = server.value;
  const value = raw !== undefined && raw !== null ? raw : spec.fallback;
  return spec.toUi ? spec.toUi(value) : value;
}

export function isSettingPinned(spec, serverSettings, readStored) {
  const server = serverSettings ? serverSettings[spec.serverKey] : undefined;
  return readStored(spec.storageKey) !== null || !!(server && (server.overridden || server.locked));
}

function boolSpec(key, fallback, propagate) {
  return {
    id: key,
    serverKey: key,
    storageKey: key,
    parse: (v) => v === "true",
    fallback,
    propagate,
  };
}

export const HIDPI_SPEC = {
  id: "hidpi",
  serverKey: "use_css_scaling",
  storageKey: "useCssScaling",
  parse: (v) => v === "true",
  conditional: (ctx) => (ctx.manualActive ? true : undefined),
  fallback: false,
  toUi: (cssScaling) => !cssScaling,
  toServer: (hidpi) => !hidpi,
  serialize: (hidpi) => String(!hidpi),
  propagate: (cssScaling, _ctx, io) =>
    io.postToCore({ type: "setUseCssScaling", value: cssScaling }),
};

export const RATE_CONTROL_SPEC = {
  id: "rate_control_mode",
  serverKey: "rate_control_mode",
  storageKey: "rate_control_mode",
  conditional: (ctx) => (ctx.streamMode === "webrtc" ? "cbr" : "crf"),
  isValid: (v, ctx) => (ctx.allowedRateControl || ["cbr", "crf"]).includes(v),
  fallback: "crf",
  propagate: (mode, _ctx, io) => io.postSetting({ rate_control_mode: mode }),
};

export const USE_BROWSER_CURSORS_SPEC = boolSpec(
  "use_browser_cursors",
  false,
  (value, _ctx, io) => io.postToCore({ type: "setUseBrowserCursors", value }),
);
export const VIDEO_FULLCOLOR_SPEC = boolSpec(
  "video_fullcolor",
  false,
  (value, _ctx, io) => io.postSetting({ video_fullcolor: value }),
);
export const VIDEO_STREAMING_MODE_SPEC = boolSpec(
  "video_streaming_mode",
  false,
  (value, _ctx, io) => io.postSetting({ video_streaming_mode: value }),
);
export const USE_PAINT_OVER_QUALITY_SPEC = {
  ...boolSpec("use_paint_over_quality", true, (value, _ctx, io) =>
    io.postSetting({ use_paint_over_quality: value }),
  ),
  conditional: (ctx) =>
    ctx.rateControlMode === "cbr" ? false : ctx.rateControlMode === "crf" ? true : undefined,
};
export const USE_CPU_SPEC = boolSpec("use_cpu", false, (value, _ctx, io) =>
  io.postSetting({ use_cpu: value }),
);
export const FORCE_ALIGNED_RESOLUTION_SPEC = boolSpec(
  "force_aligned_resolution",
  false,
  (value, _ctx, io) => io.postSetting({ force_aligned_resolution: value }),
);
