/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Original Jolee session-token helpers for dashboard compiles. Not selkies-web-core.
 * The hop uses fragment `#token=` (query `?token=` fallback) and `?session=`.
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

function pageToken() {
  return pageSearchParams().get("token") || pageHashParams().get("token") || "";
}

function pageSession() {
  return pageSearchParams().get("session") || "";
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
