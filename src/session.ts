import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { decodeEnvelope, envelopeByteLength, MAX_ENVELOPE_BYTES } from "./envelope";
import { fileFromFrame } from "./json-frame";
import { timingSafeEqual } from "./tokens";
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  type PublicStatus,
} from "./types";

export type Env = {
  Session: DurableObjectNamespace<Session>;
  ASSETS?: Fetcher;
  MINT_SECRET?: string;
};

type SessionRow = {
  id: string;
  browser_token: string;
  agent_token: string;
  expires_at: number;
  created_at: number;
  state: string;
};

type Role = "browser" | "agent";

type ConnState = { role: Role; joined: boolean };

export class Session extends Server<Env> {
  static options = { hibernate: true };

  private tearingDown = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        browser_token TEXT NOT NULL,
        agent_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        state TEXT NOT NULL
      )`);
      this.ensureFilesTable();
    });
  }

  async mint(input: {
    sessionId: string;
    browserToken: string;
    agentToken: string;
    ttlSeconds?: number;
  }): Promise<{ sessionId: string; expiresAt: number; ttlSeconds: number }> {
    // Persist PartyServer name for alarms/hibernation when ctx.id.name is missing.
    await this.setName(input.sessionId);
    const existing = this.loadRow();
    if (existing) {
      throw new Error("session already minted");
    }
    const ttlSeconds = clampTtl(input.ttlSeconds);
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    this.ctx.storage.sql.exec(
      "INSERT INTO session (id, browser_token, agent_token, expires_at, created_at, state) VALUES (?, ?, ?, ?, ?, ?)",
      input.sessionId,
      input.browserToken,
      input.agentToken,
      expiresAt,
      now,
      "waiting",
    );
    await this.ctx.storage.setAlarm(expiresAt);
    return { sessionId: input.sessionId, expiresAt, ttlSeconds };
  }

  async status(): Promise<PublicStatus | null> {
    const row = this.loadRow();
    if (!row || row.state === "ended") return null;
    const expired = Date.now() >= row.expires_at;
    const browserConnected = this.hasRole("browser");
    const agentConnected = this.hasRole("agent");
    return {
      sessionId: row.id,
      state: expired ? "expired" : browserConnected && agentConnected ? "paired" : "waiting",
      expiresAt: row.expires_at,
      browserConnected,
      agentConnected,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const denied = this.denyJoin(request);
      if (denied) return denied;
    }
    return super.fetch(request);
  }

  getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const role = roleFromRequest(context.request);
    return role ? [role] : [];
  }

  async onConnect(connection: Connection<ConnState>, ctx: ConnectionContext): Promise<void> {
    const role = roleFromRequest(ctx.request);
    if (!role) {
      connection.close(4002, "invalid role");
      return;
    }
    // Use serializeAttachment, not setState: PartyServer's setState overwrites
    // the socket attachment and drops the __pk metadata hibernation needs.
    const token = tokenFromRequest(ctx.request);
    if (!token) {
      // Join-via-first-message path authenticates after upgrade.
      connection.serializeAttachment({ role, joined: false });
      return;
    }
    const row = this.loadRow();
    if (!row || row.state === "ended") {
      connection.serializeAttachment({ role, joined: false });
      connection.close(4004, "session not found");
      return;
    }
    if (Date.now() >= row.expires_at) {
      connection.serializeAttachment({ role, joined: false });
      connection.close(4010, "session expired");
      return;
    }
    const expected = role === "browser" ? row.browser_token : row.agent_token;
    if (!timingSafeEqual(token, expected)) {
      connection.serializeAttachment({ role, joined: false });
      connection.close(4003, "invalid token");
      return;
    }
    connection.serializeAttachment({ role, joined: true });
    this.persistPairState();
    this.broadcastStatus();
  }

  async onMessage(connection: Connection<ConnState>, message: WSMessage): Promise<void> {
    if (typeof message === "string") {
      this.handleJoin(connection, message);
      return;
    }
    if (!this.isJoined(connection)) return;
    if (envelopeByteLength(message) > MAX_ENVELOPE_BYTES) return;
    const decoded = decodeEnvelope(message as ArrayBuffer | ArrayBufferView);
    if (!decoded) return;
    const row = this.loadRow();
    if (!row || row.state === "ended" || Date.now() >= row.expires_at) return;
    if (!this.hasRole("browser") || !this.hasRole("agent")) return;

    const sender = this.roleOf(connection);
    // Frames and audio are agent → browser only. Input is browser → agent.
    // Unknown kinds are already dropped by decodeEnvelope.
    if ((decoded.kind === "frame" || decoded.kind === "audio") && sender !== "agent") return;
    if (decoded.kind === "input" && sender !== "browser") return;

    // Stash hop file transfers into the session inbox for /api/files/.
    if (decoded.kind === "frame" || decoded.kind === "input") {
      void this.maybeStoreTransferredFile(decoded.payload, sender);
    }

    const target: Role = decoded.kind === "input" ? "agent" : "browser";
    for (const peer of this.getConnections<ConnState>(target)) {
      if (peer.id === connection.id) continue;
      if (!this.isJoined(peer)) continue;
      peer.send(message);
    }
  }

  async onClose(connection: Connection<ConnState>): Promise<void> {
    if (this.tearingDown) return;
    const row = this.loadRow();
    if (!row) return;
    if (!this.isJoined(connection)) return;
    await this.teardown();
  }

  async onError(connection: Connection<ConnState>, _error: unknown): Promise<void> {
    if (this.tearingDown) return;
    const row = this.loadRow();
    if (!row) return;
    if (!this.isJoined(connection)) return;
    await this.teardown();
  }

  async onAlarm(): Promise<void> {
    const row = this.loadRow();
    if (!row) return;
    await this.teardown();
  }


  /** Authorize browser or agent hop token for HTTP file APIs. */
  async authorizeSessionToken(token: string): Promise<Role | null> {
    const row = this.loadRow();
    if (!row || row.state === "ended") return null;
    if (Date.now() >= row.expires_at) return null;
    if (timingSafeEqual(token, row.browser_token)) return "browser";
    if (timingSafeEqual(token, row.agent_token)) return "agent";
    return null;
  }

  async listSessionFiles(): Promise<
    { id: string; name: string; mime: string; size: number; createdAt: number; source: string }[]
  > {
    this.ensureFilesTable();
    const rows = this.ctx.storage.sql
      .exec<{ id: string; name: string; mime: string; size: number; created_at: number; source: string }>(
        "SELECT id, name, mime, size, created_at, source FROM session_files ORDER BY created_at DESC",
      )
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      createdAt: r.created_at,
      source: r.source,
    }));
  }

  async putSessionFile(input: {
    name: string;
    mime: string;
    data: ArrayBuffer | Uint8Array;
    source?: string;
  }): Promise<{ id: string; name: string; mime: string; size: number; createdAt: number; source: string }> {
    this.ensureFilesTable();
    const bytes =
      input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    if (bytes.byteLength === 0) throw new Error("empty file");
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error("file too large");
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const name = (input.name || "file").slice(0, 512);
    const mime = (input.mime || "application/octet-stream").slice(0, 256);
    const source = (input.source || "inbox").slice(0, 64);
    await this.ctx.storage.put(`fileblob:${id}`, bytes);
    this.ctx.storage.sql.exec(
      "INSERT INTO session_files (id, name, mime, size, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      name,
      mime,
      bytes.byteLength,
      createdAt,
      source,
    );
    return { id, name, mime, size: bytes.byteLength, createdAt, source };
  }

  async getSessionFile(
    id: string,
  ): Promise<{ id: string; name: string; mime: string; size: number; createdAt: number; source: string; data: ArrayBuffer } | null> {
    this.ensureFilesTable();
    const rows = this.ctx.storage.sql
      .exec<{ id: string; name: string; mime: string; size: number; created_at: number; source: string }>(
        "SELECT id, name, mime, size, created_at, source FROM session_files WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    const blob = await this.ctx.storage.get<Uint8Array>(`fileblob:${id}`);
    if (!blob) return null;
    const copy = new Uint8Array(blob.byteLength);
    copy.set(blob);
    return {
      id: row.id,
      name: row.name,
      mime: row.mime,
      size: row.size,
      createdAt: row.created_at,
      source: row.source,
      data: copy.buffer,
    };
  }

  private handleJoin(connection: Connection<ConnState>, message: string): void {
    if (this.isJoined(connection)) return;
    let parsed: { type?: unknown; token?: unknown };
    try {
      parsed = JSON.parse(message) as { type?: unknown; token?: unknown };
    } catch {
      connection.close(4001, "join required");
      return;
    }
    if (parsed.type !== "join" || typeof parsed.token !== "string" || !parsed.token) {
      connection.close(4001, "join required");
      return;
    }
    const role = this.roleOf(connection);
    if (!role) {
      connection.close(4002, "invalid role");
      return;
    }
    const row = this.loadRow();
    if (!row || row.state === "ended") {
      connection.close(4004, "session not found");
      return;
    }
    if (Date.now() >= row.expires_at) {
      connection.close(4010, "session expired");
      return;
    }
    const expected = role === "browser" ? row.browser_token : row.agent_token;
    if (!timingSafeEqual(parsed.token, expected)) {
      connection.close(4003, "invalid token");
      return;
    }
    if (this.hasRole(role)) {
      connection.close(4009, "already connected");
      return;
    }
    connection.serializeAttachment({ role, joined: true });
    this.persistPairState();
    this.broadcastStatus();
  }

  private denyJoin(request: Request): Response | null {
    const row = this.loadRow();
    if (!row || row.state === "ended") {
      return jsonError("session not found", 404);
    }
    if (Date.now() >= row.expires_at) {
      return jsonError("session expired", 410);
    }
    const role = roleFromRequest(request);
    const token = tokenFromRequest(request);
    if (!role) return jsonError("role required", 400);
    if (this.hasRole(role)) {
      return jsonError(role + " already connected", 409);
    }
    if (!token) {
      // First text message `{type:"join","token"}` authenticates after upgrade.
      return null;
    }
    const expected = role === "browser" ? row.browser_token : row.agent_token;
    if (!timingSafeEqual(token, expected)) {
      return jsonError("invalid token", 403);
    }
    return null;
  }

  private roleOf(connection: Connection<ConnState>): Role | null {
    const attached = this.connState(connection);
    if (attached?.role === "browser" || attached?.role === "agent") return attached.role;
    if (connection.tags.includes("browser")) return "browser";
    if (connection.tags.includes("agent")) return "agent";
    return null;
  }

  private isJoined(connection: Connection<ConnState>): boolean {
    const attached = this.connState(connection);
    if (attached && typeof attached.joined === "boolean") return attached.joined;
    return true;
  }

  private connState(connection: Connection<ConnState>): ConnState | null {
    const fromState = connection.state;
    if (fromState?.role === "browser" || fromState?.role === "agent") return fromState;
    try {
      const attached = connection.deserializeAttachment() as ConnState | null;
      if (attached?.role === "browser" || attached?.role === "agent") return attached;
    } catch {
      // no attachment
    }
    return null;
  }

  private hasRole(role: Role): boolean {
    for (const conn of this.getConnections<ConnState>(role)) {
      if (this.isJoined(conn)) return true;
    }
    return false;
  }

  private persistPairState(): void {
    const row = this.loadRow();
    if (!row || row.state === "ended") return;
    const paired = this.hasRole("browser") && this.hasRole("agent");
    const next = paired ? "paired" : "waiting";
    if (row.state !== next) {
      this.ctx.storage.sql.exec("UPDATE session SET state = ?", next);
    }
  }

  private broadcastStatus(): void {
    const status = this.snapshot();
    if (!status) return;
    this.broadcast(JSON.stringify({ type: "status", ...status }));
  }

  private snapshot(): PublicStatus | null {
    const row = this.loadRow();
    if (!row || row.state === "ended") return null;
    const browserConnected = this.hasRole("browser");
    const agentConnected = this.hasRole("agent");
    const expired = Date.now() >= row.expires_at;
    return {
      sessionId: row.id,
      state: expired ? "expired" : browserConnected && agentConnected ? "paired" : "waiting",
      expiresAt: row.expires_at,
      browserConnected,
      agentConnected,
    };
  }



  private async maybeStoreTransferredFile(payload: Uint8Array, sender: Role | null): Promise<void> {
    try {
      const file = fileFromFrame(payload);
      if (!file) return;
      const bin = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      await this.putSessionFile({
        name: file.name,
        mime: file.mime,
        data: bin,
        source: sender === "agent" ? "agent-push" : "browser-push",
      });
    } catch {
      // ignore malformed / oversized transfers
    }
  }

  private ensureFilesTable(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL
    )`);
  }

  private loadRow(): SessionRow | null {
    try {
      const rows = this.ctx.storage.sql
        .exec<SessionRow>("SELECT * FROM session LIMIT 1")
        .toArray();
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private async teardown(): Promise<void> {
    if (this.tearingDown) return;
    this.tearingDown = true;
    this.ctx.storage.sql.exec("UPDATE session SET state = ?", "ended");
    for (const conn of this.getConnections()) {
      try {
        conn.close(4000, "session ended");
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAll();
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        browser_token TEXT NOT NULL,
        agent_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        state TEXT NOT NULL
      )`);
    this.ensureFilesTable();
  }
}

function clampTtl(ttl?: number): number {
  const n =
    typeof ttl === "number" && Number.isFinite(ttl)
      ? Math.floor(ttl)
      : DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, n));
}

function roleFromRequest(request: Request): Role | null {
  const url = new URL(request.url);
  const q = url.searchParams.get("role");
  if (q === "browser" || q === "agent") return q;
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === "browser" || last === "agent") return last;
  return null;
}

function tokenFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  if (q) return q;
  const auth = request.headers.get("Authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
