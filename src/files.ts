import { getServerByName } from "partyserver";
import type { Env } from "./session";
import { sessionFromRequest, tokenFromRequest } from "./files-auth";
import { isSafeFilesPath, type FilesListEntry } from "./json-frame";
import header from "../chrome/selkies-files/header.html";
import footer from "../chrome/selkies-files/footer.html";

const COOKIE_ATTRS = "Path=/api/files; Secure; HttpOnly; SameSite=Lax";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function filesPageHtml(path: string, files: FilesListEntry[]): string {
  const rows = files.map((file) => {
    const directory = file.type === "dir";
    const href = encodeURIComponent(file.name) + (directory ? "/" : "");
    const date = new Date(file.mtime);
    const formattedDate = Number.isFinite(date.getTime())
      ? date.toISOString().slice(0, 19).replace("T", " ") : "—";
    return `<tr><td><a href="${escapeHtml(href)}">${escapeHtml(file.name)}${directory ? "/" : ""}</a></td><td>${formattedDate}</td><td>${directory ? "—" : (file.size / 1024).toFixed(1) + " KB"}</td></tr>`;
  }).join("\n");
  // Stock footer rewrites h1 with this prefix and keeps directories navigable.
  return `${header}/api/files/${escapeHtml(path ? path + "/" : "")}</h1>
<script>window.__SELKIES_INJECTED_PATH_PREFIX__ = "/api/files";</script>
<table id="list"><thead><tr><th>File Name</th><th>Date</th><th>Size</th></tr></thead>
<tbody><tr><td><a href="../">../</a></td><td></td><td></td></tr>${rows}</tbody></table>${footer}`;
}

function responseHeaders(): Headers {
  return new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
}

function errorResponse(error: string, status: number): Response {
  const headers = responseHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error }), { status, headers });
}

export function isFilesApiPath(pathname: string): boolean {
  return pathname === "/api/files" || pathname.startsWith("/api/files/");
}

/** Public hop subset: paired-PC reads only, authenticated by session tokens. */
export async function handleFilesApi(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    const response = errorResponse("method_not_allowed", 405);
    response.headers.set("allow", "GET");
    return response;
  }
  const url = new URL(request.url);
  const sessionId = sessionFromRequest(request, url);
  const token = tokenFromRequest(request, url);
  if (!sessionId || !token) return errorResponse("session_and_token_required", 401);

  const directory = url.pathname === "/api/files" || url.pathname.endsWith("/");
  let path: string;
  try {
    const encoded = url.pathname.slice("/api/files/".length);
    path = decodeURIComponent(directory && encoded.endsWith("/") ? encoded.slice(0, -1) : encoded);
  } catch {
    return errorResponse("bad_name", 400);
  }
  if (!isSafeFilesPath(path, directory)) return errorResponse("bad_name", 400);
  // An extra slash after the mount is an empty segment, not the root.
  if (url.pathname === "/api/files//") return errorResponse("bad_name", 400);

  const stub = await getServerByName(env.Session, sessionId);
  if (!await stub.authorizeSessionToken(token)) return errorResponse("session_token_mismatch", 403);

  const headers = responseHeaders();
  headers.append("set-cookie", `jolee_session=${encodeURIComponent(sessionId)}; ${COOKIE_ATTRS}`);
  headers.append("set-cookie", `jolee_browser_token=${encodeURIComponent(token)}; ${COOKIE_ATTRS}`);
  if (url.pathname === "/api/files") {
    url.pathname += "/";
    headers.set("location", url.toString());
    return new Response(null, { status: 308, headers });
  }
  if (directory) {
    const listed = await stub.askAgentFilesList(path);
    if (!listed.ok) return errorResponse(listed.error, listed.error === "bad_name" ? 400 : 503);
    if (url.searchParams.get("format") === "json") {
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({ sessionId, source: "pc", path: listed.path, files: listed.files }), { headers });
    }
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(filesPageHtml(listed.path, listed.files), { headers });
  }
  const got = await stub.askAgentFilesGet(path);
  if (!got.ok) {
    const status = got.error === "bad_name" ? 400 : got.error === "not_found" ? 404 : got.error === "too_large" ? 413 : 503;
    return errorResponse(got.error, status);
  }
  const basename = got.name.split("/").pop()!;
  const safeName = basename.replace(/[^\w.\- ()[\]]+/g, "_") || "download";
  // Agent-controlled MIME must not create invalid HTTP headers.
  const mime = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(got.mime) ? got.mime : "application/octet-stream";
  headers.set("content-type", mime);
  headers.set("content-length", String(got.data.byteLength));
  headers.set("content-disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(basename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`);
  return new Response(got.data, { headers });
}
