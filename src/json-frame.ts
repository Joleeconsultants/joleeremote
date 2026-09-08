/**
 * Viewer JSON-frame payloads on envelope kind 0x01 (same pattern as clipboard).
 * The hop forwards these opaquely; it does not parse them. Keep the copies in
 * public/viewer.html in sync. Do not add envelope kind 0x04 for cursor.
 */

function skipSpace(payload: Uint8Array): number {
  let i = 0;
  while (
    i < payload.length &&
    (payload[i] === 0x20 ||
      payload[i] === 0x09 ||
      payload[i] === 0x0a ||
      payload[i] === 0x0d)
  ) {
    i++;
  }
  return i;
}

export function parseJsonFrameObject(
  payload: Uint8Array,
): Record<string, unknown> | null {
  try {
    const i = skipSpace(payload);
    if (i >= payload.length || payload[i] !== 0x7b) return null;
    const obj = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type ClipboardFrame =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; data: string };

export function clipboardTextFromFrame(
  payload: Uint8Array,
): ClipboardFrame | null {
  const obj = parseJsonFrameObject(payload);
  if (!obj) return null;
  if (!(obj.t === "clipboard" || obj.type === "clipboard")) return null;
  if (
    typeof obj.mime === "string" &&
    obj.mime.indexOf("image/") === 0 &&
    typeof obj.data === "string"
  ) {
    return { kind: "image", mime: obj.mime, data: obj.data };
  }
  if (typeof obj.text === "string") return { kind: "text", text: obj.text };
  return null;
}

export type CursorFrame = {
  visible: boolean;
  hx: number;
  hy: number;
  mime: string;
  data: string;
};

export function cursorFromFrame(payload: Uint8Array): CursorFrame | null {
  const obj = parseJsonFrameObject(payload);
  if (!obj) return null;
  if (!(obj.t === "cursor" || obj.type === "cursor")) return null;
  const hx = typeof obj.hx === "number" && Number.isFinite(obj.hx) ? obj.hx : 0;
  const hy = typeof obj.hy === "number" && Number.isFinite(obj.hy) ? obj.hy : 0;
  const mime = typeof obj.mime === "string" ? obj.mime : "";
  const data = typeof obj.data === "string" ? obj.data : "";
  return { visible: obj.visible !== false, hx, hy, mime, data };
}

export type FileFrame = { name: string; mime: string; data: string };

export function fileFromFrame(payload: Uint8Array): FileFrame | null {
  const obj = parseJsonFrameObject(payload);
  if (!obj || !(obj.t === "file" || obj.type === "file")) return null;
  if (typeof obj.name !== "string" || typeof obj.data !== "string") return null;
  return {
    name: obj.name,
    mime: typeof obj.mime === "string" ? obj.mime : "application/octet-stream",
    data: obj.data,
  };
}

export function statsFromFrame(
  payload: Uint8Array,
): Record<string, unknown> | null {
  const obj = parseJsonFrameObject(payload);
  if (!obj || !(obj.t === "stats" || obj.type === "stats")) return null;
  return obj;
}

export type PrintFrame = {
  name: string;
  mime: string;
  data: string;
  job: string;
  part: number;
  parts: number;
};

/** Agent finished a session print job (often PDF after PostScript convert). */
export function printFromFrame(payload: Uint8Array): PrintFrame | null {
  const obj = parseJsonFrameObject(payload);
  if (!obj || !(obj.t === "print" || obj.type === "print")) return null;
  if (typeof obj.data !== "string") return null;
  const parts =
    typeof obj.parts === "number" && Number.isFinite(obj.parts) && obj.parts >= 1
      ? Math.floor(obj.parts)
      : 1;
  const part =
    typeof obj.part === "number" && Number.isFinite(obj.part) && obj.part >= 0
      ? Math.floor(obj.part)
      : 0;
  if (part >= parts) return null;
  return {
    name: typeof obj.name === "string" && obj.name ? obj.name : "print.pdf",
    mime: typeof obj.mime === "string" && obj.mime ? obj.mime : "application/pdf",
    data: obj.data,
    job: typeof obj.job === "string" && obj.job ? obj.job : "single",
    part,
    parts,
  };
}

export type FilesListEntry = { id: string; name: string; type: "dir" | "file"; size: number; mtime: number };

export type FilesListFrame = { t: "filesList"; path: string; files: FilesListEntry[] };

export type FilesGetSuccessFrame = {
  t: "filesGet";
  name: string;
  mime: string;
  data: string;
};

export type FilesGetErrorFrame = {
  t: "filesGet";
  name: string;
  error: "not_found" | "too_large" | "unavailable";
};

export type FilesGetFrame = FilesGetSuccessFrame | FilesGetErrorFrame;

const FILES_GET_ERRORS = new Set(["not_found", "too_large", "unavailable"]);

/** Clean root-relative paths; disk containment/reparse checks stay agent-side. */
export function isSafeFilesPath(path: string, allowRoot = false): boolean {
  if (typeof path !== "string") return false;
  if (path === "") return allowRoot;
  return path.split("/").every((segment) =>
    segment.length > 0 &&
    !/[\\\x00-\x1f\x7f-\x9f<>:"|?*]/.test(segment) &&
    !/[. ]$/.test(segment) &&
    !/^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment)
  );
}

export function isSafeFilesBasename(name: string): boolean {
  return isSafeFilesPath(name) && !name.includes("/");
}

export function encodeFilesListRequest(path = ""): string {
  return JSON.stringify(path ? { t: "filesList", path } : { t: "filesList" });
}

export function encodeFilesGetRequest(name: string): string {
  return JSON.stringify({ t: "filesGet", name });
}

export function filesListFromFrame(payload: Uint8Array): FilesListFrame | null {
  const obj = parseJsonFrameObject(payload);
  if (!obj || !(obj.t === "filesList" || obj.type === "filesList")) return null;
  if (!Array.isArray(obj.files)) return null;
  const path = obj.path === undefined ? "" : obj.path;
  if (typeof path !== "string" || !isSafeFilesPath(path, true)) return null;
  const files: FilesListEntry[] = [];
  for (const entry of obj.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.name !== "string" || !isSafeFilesBasename(rec.name)) continue;
    if (typeof rec.size !== "number" || !Number.isFinite(rec.size) || rec.size < 0) continue;
    if (typeof rec.mtime !== "number" || !Number.isFinite(rec.mtime)) continue;
    const id = path ? path + "/" + rec.name : rec.name;
    if (rec.id !== undefined && rec.id !== id) continue;
    if (rec.type !== undefined && rec.type !== "dir" && rec.type !== "file") continue;
    files.push({
      id,
      name: rec.name,
      type: rec.type === "dir" ? "dir" : "file",
      size: rec.type === "dir" ? 0 : Math.floor(rec.size),
      mtime: Math.floor(rec.mtime),
    });
  }
  return { t: "filesList", path, files };
}

export function filesGetFromFrame(payload: Uint8Array): FilesGetFrame | null {
  const obj = parseJsonFrameObject(payload);
  if (!obj || !(obj.t === "filesGet" || obj.type === "filesGet")) return null;
  if (typeof obj.name !== "string" || !isSafeFilesPath(obj.name)) return null;
  if (typeof obj.error === "string" && FILES_GET_ERRORS.has(obj.error)) {
    return {
      t: "filesGet",
      name: obj.name,
      error: obj.error as FilesGetErrorFrame["error"],
    };
  }
  if (typeof obj.data !== "string") return null;
  return {
    t: "filesGet",
    name: obj.name,
    mime: typeof obj.mime === "string" && obj.mime ? obj.mime : "application/octet-stream",
    data: obj.data,
  };
}

