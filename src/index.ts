import { getServerByName, routePartykitRequest } from "partyserver";
import { Session, type Env } from "./session";
import { handleFilesApi, isFilesApiPath } from "./files";
import { randomToken } from "./tokens";
import {
  clampTtlSeconds,
  resolveSessionTtlSeconds,
  type MintResponse,
} from "./types";
import { agentJoinPath, viewerPath } from "./joins";
import { authorizeMint } from "./mint-auth";

export { Session };
export {
  agentJoinPath,
  browserJoinPath,
  partyBrowserPath,
  viewerPath,
  viewerQuery,
  viewerHash,
} from "./joins";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-mint-secret",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (isFilesApiPath(url.pathname)) return handleFilesApi(request, env);

    if (request.method === "POST" && url.pathname === "/sessions") {
      return withCors(await mint(request, env));
    }

    const statusMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (request.method === "GET" && statusMatch) {
      return withCors(await sessionStatus(statusMatch[1], env));
    }

    const joinMatch = url.pathname.match(/^\/sessions\/([^/]+)\/(browser|agent)$/);
    if (joinMatch) {
      const sessionId = joinMatch[1];
      const role = joinMatch[2];
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "expected websocket upgrade" }, 426);
      }
      // Prefer getServerByName (calls setName) over raw getByName+fetch: local
      // wrangler often leaves ctx.id.name undefined. Keep x-partykit-room as a
      // fallback if the WebSocket Request rewrite drops memory state.
      const stub = await getServerByName(env.Session, sessionId);
      const fwd = withQuery(request, { role });
      const headers = new Headers(fwd.headers);
      headers.set("x-partykit-room", sessionId);
      return stub.fetch(new Request(fwd, { headers }));
    }

    // routePartykitRequest uses idFromName+fetch but does not set x-partykit-room.
    // Under local wrangler (ctx.id.name often undefined), ensure __ps_name via setName
    // so PartySocket browser joins work after mint and on reconnect.
    const partyMatch = url.pathname.match(/^\/parties\/session\/([^/]+)/);
    if (partyMatch) {
      await getServerByName(env.Session, partyMatch[1]);
    }
    const party = await routePartykitRequest(request, env);
    if (party) return party;

    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      return withMediaPermissions(asset, url.pathname);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function mint(request: Request, env: Env): Promise<Response> {
  if (!authorizeMint(request, env.MINT_SECRET)) {
    return json({ error: "mint secret required" }, 401);
  }

  const defaultTtl = resolveSessionTtlSeconds(env.SESSION_TTL_SECONDS);
  let ttlSeconds = defaultTtl;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { ttlSeconds?: unknown };
      if (typeof body.ttlSeconds === "number") ttlSeconds = body.ttlSeconds;
    } catch {
      return json({ error: "invalid json" }, 400);
    }
  }
  ttlSeconds = clampTtlSeconds(ttlSeconds, defaultTtl);

  const sessionId = crypto.randomUUID();
  const browserToken = randomToken();
  const agentToken = randomToken();
  const hop = new URL(request.url).host;
  // getServerByName calls setName so hibernation/alarms have a persisted __ps_name
  // even when local wrangler leaves ctx.id.name undefined.
  const stub = await getServerByName(env.Session, sessionId);
  try {
    const minted = await stub.mint({
      sessionId,
      browserToken,
      agentToken,
      ttlSeconds,
    });
    const body: MintResponse = {
      sessionId: minted.sessionId,
      browserToken,
      agentToken,
      expiresAt: minted.expiresAt,
      ttlSeconds: minted.ttlSeconds,
      joins: {
        browser: viewerPath(minted.sessionId, browserToken, hop),
        agent: agentJoinPath(minted.sessionId, agentToken),
      },
    };
    return json(body, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "mint failed";
    return json({ error: message }, 409);
  }
}

async function sessionStatus(sessionId: string, env: Env): Promise<Response> {
  const stub = env.Session.getByName(sessionId);
  const data = await stub.status();
  if (!data) return json({ error: "session not found" }, 404);
  return json(data);
}

function withQuery(request: Request, query: Record<string, string>): Request {
  const url = new URL(request.url);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, request);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Ensure HTML shells advertise mic/camera for the Selkies iframe allow list. */
function withMediaPermissions(response: Response, pathname: string): Response {
  const lower = pathname.toLowerCase();
  const isHtml =
    lower === "/" ||
    lower.endsWith(".html") ||
    (response.headers.get("content-type") || "").includes("text/html");
  if (!isHtml) return response;
  const headers = new Headers(response.headers);
  if (!headers.has("Permissions-Policy")) {
    headers.set(
      "Permissions-Policy",
      "microphone=*, camera=*, fullscreen=*",
    );
  }
  return new Response(response.body, { status: response.status, headers });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
