/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Original Jolee session-token helpers for dashboard compiles. Not selkies-web-core.
 * The hop uses fragment `#token=` (query `?token=` fallback) and `?session=`.
 * Cookie token is only used when it belongs to the same session as the page.
 * @module
 */

function pageSearchParams() {
  if (typeof window === "undefined" || !window.location) {
    return new URLSearchParams();
  }
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

function pageHashParams() {
  if (typeof window === "undefined" || !window.location) {
    return new URLSearchParams();
  }
  try {
    return new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
  } catch {
    return new URLSearchParams();
  }
}

function cookieValue(name) {
  if (typeof document === "undefined" || !document.cookie) return "";
  try {
    const parts = document.cookie.split(";");
    for (const part of parts) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim();
      if (key !== name) continue;
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  } catch {
    return "";
  }
  return "";
}

function pageToken() {
  const fromUrl =
    pageSearchParams().get("token") || pageHashParams().get("token") || "";
  if (fromUrl) return fromUrl;

  const pageSess = pageSearchParams().get("session") || "";
  const cookieSess = cookieValue("jolee_session");
  // Page session present but cookie session differs (or missing) → ignore cookie token.
  if (pageSess && cookieSess !== pageSess) {
    return "";
  }
  return cookieValue("jolee_browser_token") || "";
}

function pageSession() {
  return pageSearchParams().get("session") || cookieValue("jolee_session") || "";
}

export function sessionAuthHeaders(headers) {
  const base = Object.assign({}, headers || {});
  const token = pageToken();
  if (token && !("Authorization" in base)) {
    base.Authorization = `Bearer ${token}`;
  }
  return base;
}

/** Attach session + browser token so ./api/files/ can authorize against the hop. */
export function withSessionToken(url) {
  const token = pageToken();
  const session = pageSession();
  try {
    const resolved = new URL(url, window.location.href);
    if (token) resolved.searchParams.set("token", token);
    if (session) resolved.searchParams.set("session", session);
    return resolved.href;
  } catch {
    return url;
  }
}
