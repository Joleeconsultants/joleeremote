export const HANDLED_DASHBOARD_TYPES = [
  "connect",
  "disconnect",
  "requestFullscreen",
  "setScaleLocally",
  "showVirtualKeyboard",
  "clipboardUpdateFromUI",
  "clipboardImageUpdate",
  "setAntiAliasing",
  "setUseBrowserCursors",
  "pipelineControl",
  "micChunk",
  "audioDeviceSelected",
  "setManualResolution",
  "resetResolutionToWindow",
  "setUseCssScaling",
  "settings",
  "fileUpload",
  "command",
  "getStats",
  "touchinput:trackpad",
  "touchinput:touch",
] as const;

export const NOOP_DASHBOARD_TYPES = [
  "gamepadControl",
  "requestGamingMode",
  "sidebarVisibilityChanged",
  "TOUCH_GAMEPAD_SETUP",
  "TOUCH_GAMEPAD_VISIBILITY",
  "setSynth",
  "mode",
] as const;

export type DashboardAction =
  | "connect"
  | "disconnect"
  | "requestFullscreen"
  | "setScaleLocally"
  | "showVirtualKeyboard"
  | "clipboardUpdateFromUI"
  | "clipboardImageUpdate"
  | "setAntiAliasing"
  | "setUseBrowserCursors"
  | "pipelineControl"
  | "micChunk"
  | "audioDeviceSelected"
  | "setManualResolution"
  | "resetResolutionToWindow"
  | "setUseCssScaling"
  | "settings"
  | "fileUpload"
  | "command"
  | "getStats"
  | "touchinput:trackpad"
  | "touchinput:touch"
  | "noop"
  | "ignore";

/**
 * Classifies a postMessage payload from dashboard chrome to the hop core.
 * Keep in sync with public/viewer.html.
 */
export function classifyDashboardMessage(data: unknown): DashboardAction {
  if (!data || typeof data !== "object" || !("type" in data)) return "ignore";
  const type = (data as { type: unknown }).type;
  if (typeof type !== "string") return "ignore";
  if ((HANDLED_DASHBOARD_TYPES as readonly string[]).includes(type)) {
    return type as DashboardAction;
  }
  if ((NOOP_DASHBOARD_TYPES as readonly string[]).includes(type)) return "noop";
  return "ignore";
}

export type HopViewerStatus = "waiting" | "paired" | "expired" | "disconnected";

export function statusMessage(
  state: HopViewerStatus,
): { type: "status"; state: HopViewerStatus } {
  return { type: "status", state };
}
