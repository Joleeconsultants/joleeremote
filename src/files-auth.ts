/** Session/token extraction for /api/files/ (query, Bearer, cookies). */

export function cookieValue(request: Request, name: string): string {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    const val = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(val);
    } catch {
      return val;
    }
  }
  return "";
}

export function tokenFromRequest(request: Request, url: URL): string {
  const q = url.searchParams.get("token")?.trim() ?? "";
  if (q) return q;
  const auth = request.headers.get("Authorization") ?? "";
  const match = auth.match(/^Bearer\s+(\S+)/i);
  const bearer = match?.[1]?.trim() ?? "";
  if (bearer) return bearer;

  const sessionQ = (url.searchParams.get("session") ?? "").trim();
  const cookieSess = cookieValue(request, "jolee_session").trim();
  // Never pair a stale cookie token with a different ?session=.
  if (sessionQ && cookieSess !== sessionQ) {
    return "";
  }
  return cookieValue(request, "jolee_browser_token").trim();
}

export function sessionFromRequest(request: Request, url: URL): string {
  const q = (url.searchParams.get("session") ?? "").trim();
  if (q) return q;
  return cookieValue(request, "jolee_session").trim();
}
