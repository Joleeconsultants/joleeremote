/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */


/**
 * Overlay hide-flags for the vendored sidebar. Add chrome back as the hop
 * grows; Apps and Sharing stay hidden until their hop exists.
 * Hide gaming (gamepads, gaming mode, trackpad, extra players).
 * Audio playback (kind 0x03), microphone, webcam, and screen size / DPI /
 * HiDPI are unlocked (core toggles enabled / toggleable). Files, stats,
 * shortcuts, and agent-owned encoder preference (default H.264; JPEG fallback) has a hop path. There
 * is no pixelflux. Image clipboard is unlocked. Prefer this overlay for
 * flags so Sidebar patches stay small.
 * Locked settings make isRenderable return false (or hide the manual
 * resolution block via serverSettings.manual_resolution.locked).
 */
function flag(value) {
  return { value };
}

export const JOLEE_SERVER_SETTINGS = {
  ui_title: flag("Jolee Remote"),
  ui_show_logo: flag(false),
  ui_sidebar_show_video_settings: flag(true),
  ui_sidebar_show_screen_settings: flag(true),
  ui_sidebar_show_audio_settings: flag(true),
  ui_sidebar_show_stats: flag(true),
  ui_sidebar_show_clipboard: flag(true),
  ui_sidebar_show_files: flag(true),
  ui_sidebar_show_apps: flag(false),
  ui_sidebar_show_sharing: flag(false),
  ui_sidebar_show_gamepads: flag(false),
  ui_sidebar_show_shortcuts: flag(true),
  ui_sidebar_show_fullscreen: flag(true),
  ui_sidebar_show_gaming_mode: flag(false),
  ui_sidebar_show_trackpad: flag(false),
  ui_sidebar_show_keyboard_button: flag(true),
  ui_sidebar_show_soft_buttons: flag(false),
  ui_show_core_buttons: flag(true),
  ui_sidebar_show_webcam: flag(true),
  clipboard_enabled: flag(true),
  enable_sharing: flag(false),
  enable_shared: flag(false),
  enable_player2: flag(false),
  enable_player3: flag(false),
  enable_player4: flag(false),
  enable_dual_mode: flag(false),
  enable_binary_clipboard: { value: true },
  enable_rate_control: flag(false),
  rate_control_mode: { value: "cbr", allowed: ["cbr"], locked: true },
  audio_enabled: { value: true },
  microphone_enabled: flag(true),
  webcam_enabled: flag(true),
  gamepad_enabled: { value: false, locked: true },
  use_css_scaling: { value: true },
  force_aligned_resolution: { value: false },
  scaling_dpi: {
    value: "96",
    allowed: ["96", "120", "144", "168", "192", "216", "240", "264", "288"],
  },
  manual_resolution: { value: false },
  encoder: { value: "h264enc", allowed: ["h264enc", "jpeg"] },
  framerate: { value: 60, default: 60, min: 8, max: 240 },
  jpeg_quality: { value: 80, default: 80, min: 1, max: 100 },
  use_paint_over_quality: { value: false, locked: true },
  paint_over_jpeg_quality: { value: 80, locked: true },
  video_paintover_crf: { value: 30, locked: true },
  video_paintover_burst_frames: { value: 5, locked: true },
  video_bitrate: { value: 8000, default: 8000, min: 8000, max: 8000, locked: true },
  video_crf: { value: 25, default: 25, min: 25, max: 25, locked: true },
  video_streaming_mode: { value: false, locked: true },
  video_fullcolor: { value: false, locked: true },
  use_cpu: { value: false, locked: true },
  webcam_encoder: { value: "mjpeg", allowed: ["mjpeg"] },
  file_transfers: { value: "upload,download" },
};

export function postJoleeServerSettings() {
  window.postMessage(
    { type: "serverSettings", payload: JOLEE_SERVER_SETTINGS },
    window.location.origin,
  );
}
