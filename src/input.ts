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
  id?: string;
};
export type ClipboardInput = ClipboardTextInput | ClipboardImageInput;
export type ClipboardPasteInput = { t: "clipboard_paste"; id: string; clipboard_id: string; paste_token: string };

export type ResizeInput = {
  t: "resize";
  w: number;
  h: number;
  reset?: boolean;
  id?: string;
  mode?: "auto" | "manual" | "best_fit";
  display_id?: string;
  catalog_revision?: string;
  mode_id?: string;
  request_id?: string;
};
export type DisplaySelectInput = { t: "display_select"; display_id: string; catalog_revision: string; request_id: string };

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
export type AudioConfigInput = {t:'audio_config';v:1;requestId:string;codec:'pcm_s16le'} |
  {t:'audio_config';v:1;requestId:string;codec:'mp4a.40.2';sourceGeneration:string;
    sampleRate:number;channels:number;description:string;targetBitrate:number};

export type PipelineInput = {
  t: "pipeline";
  pipeline: string;
  enabled: boolean;
};

export type MicInput = { t: "mic"; mime: string; data: string; sample_rate?: number; channels?: number; sequence?: number };
export type WebcamInput = { t: "webcam"; mime: string; data: string };
export type FileInput = {
  t: "file";
  id?: string;
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
  | ClipboardPasteInput
  | ResizeInput
  | DisplaySelectInput
  | CssScalingInput
  | SettingsInput
  | AudioDeviceInput
  | AudioConfigInput
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
      if (obj.id !== undefined && (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 64)) return null;
      if (
        typeof obj.mime === "string" &&
        obj.mime.indexOf("image/") === 0 &&
        typeof obj.data === "string"
      ) {
        if (obj.text !== undefined) return null;
        return { t: "clipboard", mime: obj.mime, data: obj.data, ...(obj.id !== undefined ? { id: obj.id as string } : {}) };
      }
      if (typeof obj.text === "string") {
        if (obj.id !== undefined && (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 64)) return null;
        return { t: "clipboard", text: obj.text, ...(obj.id !== undefined ? { id: obj.id as string } : {}) };
      }
      return null;
    }
    case "clipboard_paste": {
      if (Object.keys(obj).some(key => !['t', 'id', 'clipboard_id', 'paste_token'].includes(key))) return null;
      if (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 64 ||
          typeof obj.clipboard_id !== "string" || obj.clipboard_id.length < 1 || obj.clipboard_id.length > 64 ||
          typeof obj.paste_token !== "string" || !/^[0-9a-f]{32}$/i.test(obj.paste_token)) return null;
      return { t: "clipboard_paste", id: obj.id, clipboard_id: obj.clipboard_id, paste_token: obj.paste_token };
    }
    case "resize": {
      if (!isFiniteNumber(obj.w) || !isFiniteNumber(obj.h)) return null;
      const out: ResizeInput = { t: "resize", w: obj.w, h: obj.h };
      const catalogRequest = ['display_id', 'catalog_revision', 'mode_id', 'request_id'].some(key => obj[key] !== undefined) || obj.mode === 'best_fit';
      if (catalogRequest) {
        if (typeof obj.display_id !== 'string' || !/^[a-f0-9]{32}$/i.test(obj.display_id) ||
            typeof obj.catalog_revision !== 'string' || !/^[a-f0-9]{32}$/i.test(obj.catalog_revision) ||
            typeof obj.request_id !== 'string' || obj.request_id.length < 1 || obj.request_id.length > 64 ||
            !Number.isInteger(obj.w) || !Number.isInteger(obj.h) || obj.w < 1 || obj.h < 1 || obj.w > 32768 || obj.h > 32768 ||
            obj.reset !== undefined || obj.id !== undefined ||
            (obj.mode !== 'manual' && obj.mode !== 'best_fit')) return null;
        if (obj.mode === 'manual' && (typeof obj.mode_id !== 'string' || !/^[a-f0-9]{32}$/i.test(obj.mode_id))) return null;
        if (obj.mode === 'best_fit' && obj.mode_id !== undefined) return null;
        out.display_id = obj.display_id; out.catalog_revision = obj.catalog_revision; out.request_id = obj.request_id;
        if (typeof obj.mode_id === 'string') out.mode_id = obj.mode_id;
      }
      if (obj.reset === true) out.reset = true;
      if (obj.id !== undefined) {
        if (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 64) return null;
        out.id = obj.id;
      }
      if (obj.mode !== undefined) {
        if (obj.mode !== "auto" && obj.mode !== "manual" && obj.mode !== "best_fit") return null;
        out.mode = obj.mode;
      }
      return out;
    }
    case "display_select": {
      if (Object.keys(obj).some(key => !['t', 'display_id', 'catalog_revision', 'request_id'].includes(key)) ||
          typeof obj.display_id !== 'string' || !/^[a-f0-9]{32}$/i.test(obj.display_id) ||
          typeof obj.catalog_revision !== 'string' || !/^[a-f0-9]{32}$/i.test(obj.catalog_revision) ||
          typeof obj.request_id !== 'string' || obj.request_id.length < 1 || obj.request_id.length > 64) return null;
      return { t: 'display_select', display_id: obj.display_id, catalog_revision: obj.catalog_revision, request_id: obj.request_id };
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
    case 'audio_config': {
      if(obj.v!==1 || typeof obj.requestId!=='string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(obj.requestId) ||
        obj.requestId==='00000000-0000-0000-0000-000000000000')return null;
      if(obj.codec==='pcm_s16le')return Object.keys(obj).length===4 ? obj as AudioConfigInput : null;
      if(obj.codec!=='mp4a.40.2'||Object.keys(obj).length!==9||typeof obj.sourceGeneration!=='string'||
        !/^[a-f0-9]{32}$/.test(obj.sourceGeneration)||![44100,48000].includes(obj.sampleRate as number)||
        ![1,2].includes(obj.channels as number)||![96000,128000,160000,192000].includes(obj.targetBitrate as number))return null;
      const asc=obj.sampleRate===44100 ? (obj.channels===1?'Egg=':'EhA=') : (obj.channels===1?'EYg=':'EZA=');
      return obj.description===asc ? obj as AudioConfigInput : null;
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
      if (obj.mime === 'audio/pcm;format=s16le;rate=24000;channels=1') {
        if (obj.sample_rate !== 24000 || obj.channels !== 1 || typeof obj.sequence !== 'number'
          || !Number.isSafeInteger(obj.sequence) || obj.sequence < 0 || !/^[A-Za-z0-9+/]{3200}$/.test(obj.data)) return null;
        return { t: 'mic', mime: obj.mime, data: obj.data, sample_rate: 24000, channels: 1, sequence: obj.sequence };
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
      if (obj.id !== undefined && (typeof obj.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(obj.id))) return null;
      if (typeof obj.name !== "string" || typeof obj.data !== "string") {
        return null;
      }
      return {
        t: "file",
        ...(obj.id === undefined ? {} : { id: obj.id as string }),
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
