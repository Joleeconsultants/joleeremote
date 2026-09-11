import { describe, expect, it } from "vitest";
import {
  classifyDashboardMessage,
  statusMessage,
} from "../src/chrome-protocol";

describe("dashboard postMessage protocol", () => {
  it("maps connect/disconnect and chrome actions", () => {
    expect(classifyDashboardMessage({ type: "connect", session: "s", token: "t" })).toBe("connect");
    expect(classifyDashboardMessage({ type: "disconnect" })).toBe("disconnect");
    expect(classifyDashboardMessage({ type: "requestFullscreen" })).toBe("requestFullscreen");
    expect(classifyDashboardMessage({ type: "setScaleLocally", value: true })).toBe("setScaleLocally");
    expect(classifyDashboardMessage({ type: "showVirtualKeyboard" })).toBe("showVirtualKeyboard");
    expect(classifyDashboardMessage({ type: "clipboardUpdateFromUI", text: "hi" })).toBe("clipboardUpdateFromUI");
    expect(classifyDashboardMessage({ type: "clipboardImageUpdate" })).toBe("clipboardImageUpdate");
    expect(classifyDashboardMessage({ type: "setAntiAliasing", value: false })).toBe("setAntiAliasing");
    expect(classifyDashboardMessage({ type: "setUseBrowserCursors", value: true })).toBe("setUseBrowserCursors");
  });

  it("handles audio playback and screen-size hops", () => {
    expect(classifyDashboardMessage({ type: "pipelineControl", pipeline: "audio", enabled: false })).toBe("pipelineControl");
    expect(classifyDashboardMessage({ type: "micChunk", mime: "audio/webm", data: "YQ==" })).toBe("micChunk");
    expect(classifyDashboardMessage({ type: "audioDeviceSelected", context: "output", deviceId: "default" })).toBe("audioDeviceSelected");
    expect(classifyDashboardMessage({ type: "setManualResolution", width: 1920, height: 1080 })).toBe("setManualResolution");
    expect(classifyDashboardMessage({ type: "resetResolutionToWindow" })).toBe("resetResolutionToWindow");
    expect(classifyDashboardMessage({ type: "setUseCssScaling", value: true })).toBe("setUseCssScaling");
    expect(classifyDashboardMessage({ type: "settings", settings: { scaling_dpi: 96 } })).toBe("settings");
    expect(classifyDashboardMessage({ type: "fileUpload" })).toBe("fileUpload");
    expect(classifyDashboardMessage({ type: "command", value: "ctrl-alt-delete" })).toBe("command");
    expect(classifyDashboardMessage({ type: "getStats" })).toBe("getStats");
  });

  it("handles touch modes independently of gaming", () => {
    expect(classifyDashboardMessage({ type: "touchinput:trackpad" })).toBe("touchinput:trackpad");
    expect(classifyDashboardMessage({ type: "touchinput:touch" })).toBe("touchinput:touch");
  });

  it("no-ops chrome that has no hop yet", () => {
    expect(classifyDashboardMessage({ type: "gamepadControl", enabled: true })).toBe("noop");
    expect(classifyDashboardMessage({ type: "requestGamingMode" })).toBe("noop");
  });

  it("ignores malformed payloads", () => {
    expect(classifyDashboardMessage(null)).toBe("ignore");
    expect(classifyDashboardMessage("connect")).toBe("ignore");
    expect(classifyDashboardMessage({ type: 1 })).toBe("ignore");
  });

  it("posts hop status names the viewer uses", () => {
    expect(statusMessage("waiting")).toEqual({ type: "status", state: "waiting" });
    expect(statusMessage("paired")).toEqual({ type: "status", state: "paired" });
    expect(statusMessage("expired")).toEqual({ type: "status", state: "expired" });
    expect(statusMessage("disconnected")).toEqual({ type: "status", state: "disconnected" });
  });
});
