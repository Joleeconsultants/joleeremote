/**
 * Parse browser → agent input JSON (envelope kind 0x02).
 * Shapes match the Selkies viewer contract in docs/agent.md.
 * Capture/inject stay OS-side; this module only interprets the wire JSON.
 */

export type PointerInput = {
  t: "pointer";
  e: "move" | "down" | "up";
  x: number;
  y: number;
  /** buttons bitfield on move; button index on down/up */
  b: number;
};

export type WheelInput = {
  t: "wheel";
  dx: number;
  dy: number;
  x: number;
  y: number;
};

export type KeyInput = {
  t: "key";
  e: "down" | "up";
  key: string;
  code: string;
};

export type ClipboardTextInput = { t: "clipboard"; text: string; id?: string };
export type ClipboardImageInput = {
  t: "clipboard";
  mime: string;
  data: string;
};
export type ClipboardInput = ClipboardTextInput | ClipboardImageInput;

export type ResizeInput = {
  t: "resize";
  w: number;
  h: number;
  reset?: boolean;
  id?: string;
  mode?: "auto" | "manual";
};

export type CssScalingInput = { t: "cssScaling"; value: boolean };

export type SettingsInput = {
  t: "settings";
  settings: Record<string, unknown>;
};

export type AudioDeviceInput = {
  t: "audioDevice";
  context: string;
  deviceId?: string;
};

export type PipelineInput = {
  t: "pipeline";
  pipeline: string;
  enabled: boolean;
};

export type MicInput = { t: "mic"; mime: string; data: string };
export type WebcamInput = { t: "webcam"; mime: string; data: string };
export type FileInput = {
  t: "file";
  name: string;
  mime: string;
  data: string;
};

export type CommandInput = { t: "command"; command: string };
export type PingInput = { t: "ping"; id: string };
export type FilesListInput = { t: "filesList" };
export type FilesGetInput = { t: "filesGet"; name: string };

export type InputPayload =
  | PointerInput
  | WheelInput
  | KeyInput
  | ClipboardInput
  | ResizeInput
  | CssScalingInput
  | SettingsInput
  | AudioDeviceInput
  | PipelineInput
  | MicInput
  | WebcamInput
  | FileInput
  | CommandInput
  | PingInput
  | FilesListInput
  | FilesGetInput;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Same CAD compact check the viewer applies before send. */
export function normalizeCommand(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z]/g, "");
  if (compact === "ctrlaltdel" || compact === "ctrlaltdelete") {
    return "ctrl-alt-delete";
  }
  return value;
}

function parseObject(obj: Record<string, unknown>): InputPayload | null {
  const t = obj.t;
  if (typeof t !== "string") return null;

  switch (t) {
    case "ping":
      return typeof obj.id === "string" && obj.id.length > 0 && obj.id.length <= 64
        ? { t: "ping", id: obj.id } : null;
    case "filesList":
      return { t: "filesList" };
    case "filesGet": {
      if (typeof obj.name !== "string" || !obj.name) return null;
      return { t: "filesGet", name: obj.name };
    }
    case "pointer": {
      const e = obj.e;
      if (e !== "move" && e !== "down" && e !== "up") return null;
      if (!isFiniteNumber(obj.x) || !isFiniteNumber(obj.y)) return null;
      const b = isFiniteNumber(obj.b) ? obj.b : 0;
      return { t: "pointer", e, x: obj.x, y: obj.y, b };
    }
    case "wheel": {
      if (
        !isFiniteNumber(obj.dx) ||
        !isFiniteNumber(obj.dy) ||
        !isFiniteNumber(obj.x) ||
        !isFiniteNumber(obj.y)
      ) {
        return null;
      }
      return { t: "wheel", dx: obj.dx, dy: obj.dy, x: obj.x, y: obj.y };
    }
    case "key": {
      const e = obj.e === "up" ? "up" : obj.e === "down" ? "down" : null;
      if (!e) return null;
      if (typeof obj.key !== "string" || typeof obj.code !== "string") {
        return null;
      }
      return { t: "key", e, key: obj.key, code: obj.code };
    }
    case "clipboard": {
      if (
        typeof obj.mime === "string" &&
        obj.mime.indexOf("image/") === 0 &&
        typeof obj.data === "string"
      ) {
        return { t: "clipboard", mime: obj.mime, data: obj.data };
      }
      if (typeof obj.text === "string") {
        if (obj.id !== undefined && (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 64)) return null;
        return { t: "clipboard", text: obj.text, ...(obj.id !== undefined ? { id: obj.id as string } : {}) };
      }
      return null;
    }
    case "resize": {
      if (!isFiniteNumber(obj.w) || !isFiniteNumber(obj.h)) return null;
      const out: ResizeInput = { t: "resize", w: obj.w, h: obj.h };
      if (obj.reset === true) out.reset = true;
      if (obj.id !== undefined) {
        if (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 64) return null;
        out.id = obj.id;
      }
      if (obj.mode !== undefined) {
        if (obj.mode !== "auto" && obj.mode !== "manual") return null;
        out.mode = obj.mode;
      }
      return out;
    }
    case "cssScaling": {
      if (typeof obj.value !== "boolean") return null;
      return { t: "cssScaling", value: obj.value };
    }
    case "settings": {
      if (!isRecord(obj.settings)) return null;
      return { t: "settings", settings: obj.settings };
    }
    case "audioDevice": {
      if (typeof obj.context !== "string") return null;
      const out: AudioDeviceInput = { t: "audioDevice", context: obj.context };
      if (typeof obj.deviceId === "string") out.deviceId = obj.deviceId;
      return out;
    }
    case "pipeline": {
      if (typeof obj.pipeline !== "string") return null;
      return {
        t: "pipeline",
        pipeline: obj.pipeline,
        enabled: !!obj.enabled,
      };
    }
    case "mic": {
      if (typeof obj.mime !== "string" || typeof obj.data !== "string") {
        return null;
      }
      return { t: "mic", mime: obj.mime, data: obj.data };
    }
    case "webcam": {
      if (typeof obj.mime !== "string" || typeof obj.data !== "string") {
        return null;
      }
      return { t: "webcam", mime: obj.mime, data: obj.data };
    }
    case "file": {
      if (typeof obj.name !== "string" || typeof obj.data !== "string") {
        return null;
      }
      return {
        t: "file",
        name: obj.name,
        mime:
          typeof obj.mime === "string" ? obj.mime : "application/octet-stream",
        data: obj.data,
      };
    }
    case "command": {
      const raw =
        typeof obj.command === "string"
          ? obj.command
          : typeof obj.value === "string"
            ? obj.value
            : null;
      if (raw === null) return null;
      return { t: "command", command: normalizeCommand(raw) };
    }
    default:
      return null;
  }
}

/** Parse UTF-8 kind-0x02 payload bytes. Returns null on garbage. */
export function parseInputPayload(bytes: Uint8Array): InputPayload | null {
  try {
    const text = new TextDecoder().decode(bytes);
    return parseInputJson(text);
  } catch {
    return null;
  }
}

/** Parse input JSON text. Returns null on garbage. */
export function parseInputJson(text: string): InputPayload | null {
  try {
    const obj = JSON.parse(text) as unknown;
    if (!isRecord(obj)) return null;
    return parseObject(obj);
  } catch {
    return null;
  }
}
