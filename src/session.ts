import { betaFeatures, betaMessageAllowed, type BetaFeatures } from './beta-features';
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { decodeEnvelope, encodeEnvelope, envelopeByteLength, MAX_ENVELOPE_BYTES } from "./envelope";
import {
  encodeFilesGetRequest,
  encodeFilesListRequest,
  fileFromFrame,
  filesGetFromFrame,
  filesListFromFrame,
  isSafeFilesPath,
  type FilesListEntry,
} from "./json-frame";
import { timingSafeEqual } from "./tokens";
import {
  DEFAULT_TTL_SECONDS,
  clampTtlSeconds,
  type PublicStatus,
} from "./types";

/** Worker → paired agent files ask timeout (Option A). */
export const FILES_ASK_TIMEOUT_MS = 12_000;

export type AgentFilesListResult =
  | { ok: true; path: string; files: FilesListEntry[] }
  | { ok: false; error: "agent_unavailable" | "timeout" | "bad_name" };

export type AgentFilesGetResult =
  | { ok: true; name: string; mime: string; data: ArrayBuffer }
  | {
      ok: false;
      error:
        | "agent_unavailable"
        | "timeout"
        | "bad_name"
        | "not_found"
        | "too_large"
        | "unavailable";
    };

type FilesAskWaiter = {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type Env = {
  Session: DurableObjectNamespace<Session>;
  ASSETS?: Fetcher;
  MINT_SECRET?: string;
  /** Default session TTL in seconds when mint omits ttlSeconds. Plaintext Worker var. */
  SESSION_TTL_SECONDS?: string;
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

  /** In-flight Option A files asks keyed by `filesList:<path>` or `filesGet:<name>`. */
  private filesAskPending = new Map<string, FilesAskWaiter[]>();

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
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_mint_context (
        session_id TEXT PRIMARY KEY,
        context TEXT
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS browser_absence (id INTEGER PRIMARY KEY, deadline INTEGER NOT NULL)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_features (
        session_id TEXT PRIMARY KEY, printing INTEGER NOT NULL, microphone INTEGER NOT NULL
      )`);
      this.ensureFilesTable();
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_renewal (
        session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
        request_id TEXT NOT NULL, previous_expiry INTEGER NOT NULL,
        expiry INTEGER NOT NULL, issued_at INTEGER NOT NULL, original_expiry INTEGER NOT NULL
      )`);
    });
  }

  async mint(input: {
    sessionId: string;
    browserToken: string;
    agentToken: string;
    ttlSeconds?: number;
    /** Internal Worker context only. HTTP mint never forwards this field. */
    mintContext?: string | null;
    betaFeatures?: BetaFeatures;
  }): Promise<{ sessionId: string; expiresAt: number; ttlSeconds: number }> {
    const flags = betaFeatures(input.betaFeatures);
    const context = input.mintContext ?? null;
    if (context !== null && (typeof context !== "string" || new TextEncoder().encode(context).length > 8192))
      throw new Error("invalid mint context");
    await this.setName(input.sessionId);
    const ttlSeconds = clampTtl(input.ttlSeconds);
    const minted = this.ctx.storage.transactionSync(() => {
      const existing = this.loadRow();
      if (existing) {
        const sealed = this.ctx.storage.sql.exec<{ context: string | null }>(
          "SELECT context FROM session_mint_context WHERE session_id = ?", existing.id).toArray();
        // Never backfill legacy sessions. Exact internal retries preserve the original deadline.
        if (sealed.length === 1 && existing.id === input.sessionId && existing.state !== "ended" &&
            Date.now() < existing.expires_at && timingSafeEqual(existing.browser_token, input.browserToken) &&
            timingSafeEqual(existing.agent_token, input.agentToken) && sealed[0].context === context &&
            JSON.stringify(this.readBetaFeatures()) === JSON.stringify(flags) &&
            existing.expires_at - existing.created_at === ttlSeconds * 1000)
          return { sessionId: existing.id, expiresAt: existing.expires_at, ttlSeconds };
        throw new Error("session already minted");
      }
      const now = Date.now();
      const expiresAt = now + ttlSeconds * 1000;
      this.ctx.storage.sql.exec(
        "INSERT INTO session (id, browser_token, agent_token, expires_at, created_at, state) VALUES (?, ?, ?, ?, ?, ?)",
        input.sessionId, input.browserToken, input.agentToken, expiresAt, now, "waiting");
      this.ctx.storage.sql.exec("INSERT INTO session_mint_context (session_id, context) VALUES (?, ?)", input.sessionId, context);
      this.ctx.storage.sql.exec("INSERT INTO session_features (session_id, printing, microphone) VALUES (?, ?, ?)", input.sessionId, Number(flags.printingBeta), Number(flags.microphoneBeta));
      return { sessionId: input.sessionId, expiresAt, ttlSeconds };
    });
    await this.ctx.storage.setAlarm(minted.expiresAt);
    return minted;
  }

  /** Worker RPC only: this context is deliberately absent from HTTP/WebSocket status. */
  async readMintContext(): Promise<{ sessionId: string; expiresAt: number; context: string | null } | null> {
    const row = this.loadRow();
    if (!row || row.state === "ended" || Date.now() >= this.sessionDeadline(row)) return null;
    const sealed = this.ctx.storage.sql.exec<{ context: string | null }>(
      "SELECT context FROM session_mint_context WHERE session_id = ?", row.id).toArray();
    return { sessionId: row.id, expiresAt: row.expires_at, context: sealed[0]?.context ?? null };
  }

  /** Internal RPC: private integration must also verify fresh operator identity. */
  async readOwnedMintContext(browserToken:string):Promise<{sessionId:string;expiresAt:number;context:string|null}|null>{
    const row=this.loadRow();
    if(!row||typeof browserToken!=='string'||!timingSafeEqual(browserToken,row.browser_token))return null;
    return this.readMintContext();
  }

  /** Immutable privileged authorization deadline; ordinary renewal must never extend it. */
  async readOriginalAuthorizationContext(): Promise<{sessionId:string;expiresAt:number;context:string|null}|null> {
    const context=await this.readMintContext();
    if(!context)return null;
    const renewal=this.ctx.storage.sql.exec<{original_expiry:number}>(
      'SELECT original_expiry FROM session_renewal WHERE session_id = ?',context.sessionId).toArray()[0];
    const expiresAt=renewal?.original_expiry ?? context.expiresAt;
    return expiresAt>Date.now()?{...context,expiresAt}:null;
  }

  async status(): Promise<PublicStatus | null> {
    const row = this.loadRow();
    if (!row || row.state === "ended") return null;
    const expired = Date.now() >= this.sessionDeadline(row);
    const browserConnected = this.hasRole("browser");
    const agentConnected = this.hasRole("agent");
    return {
      sessionId: row.id,
      state: expired ? "expired" : browserConnected && agentConnected ? "paired" : "waiting",
      expiresAt: row.expires_at,
      sessionStartedAt: row.created_at,
      browserConnected,
      agentConnected,
    };
  }

  /** Internal RPC only. Caller must verify current authorization and native applied ack.
   * No HTTP or websocket route exposes this operation to a browser or agent token.
   */
  async commitRenewal(input: { sessionId: string; requestId: string; revision: number;
    previousExpiresAt: number; expiresAt: number; issuedAt: number }): Promise<boolean> {
    const row = this.loadRow(), now = Date.now();
    if (!row || row.state === 'ended' || row.id !== input.sessionId || row.expires_at <= now ||
        !this.hasRole('browser') || !this.hasRole('agent')) return false;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId) ||
        ![input.revision,input.previousExpiresAt,input.expiresAt,input.issuedAt].every(Number.isSafeInteger) ||
        input.revision < 1 || input.issuedAt > now || input.expiresAt <= input.previousExpiresAt ||
        input.previousExpiresAt <= row.created_at ||
        input.expiresAt !== row.created_at + 2 * (input.previousExpiresAt - row.created_at) ||
        input.expiresAt - row.created_at > 2_147_483_647) return false;
    const prior = this.ctx.storage.sql.exec<{ revision:number; request_id:string;
      previous_expiry:number; expiry:number; issued_at:number; original_expiry:number }>(
      'SELECT * FROM session_renewal WHERE session_id = ?',row.id).toArray()[0];
    const replay = prior?.request_id === input.requestId && prior.revision === input.revision &&
      prior.previous_expiry === input.previousExpiresAt && prior.expiry === input.expiresAt &&
      prior.issued_at === input.issuedAt && row.expires_at === input.expiresAt;
    if (!replay) {
      if (row.expires_at !== input.previousExpiresAt || input.revision !== (prior?.revision ?? 0) + 1 ||
          prior?.request_id === input.requestId) return false;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('UPDATE session SET expires_at = ? WHERE id = ?',input.expiresAt,row.id);
        this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO session_renewal
          (session_id, revision, request_id, previous_expiry, expiry, issued_at, original_expiry) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          row.id,input.revision,input.requestId,input.previousExpiresAt,input.expiresAt,input.issuedAt,prior?.original_expiry ?? row.expires_at);
      });
    }
    await this.ctx.storage.setAlarm(this.sessionDeadline(this.loadRow()!));
    this.broadcastStatus();
    return true;
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
    if (Date.now() >= this.sessionDeadline(row)) {
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
    await this.persistPairState();
    this.broadcastStatus();
  }

  async onMessage(connection: Connection<ConnState>, message: WSMessage): Promise<void> {
    if (typeof message === "string") {
      await this.handleJoin(connection, message);
      return;
    }
    if (!this.isJoined(connection)) return;
    if (envelopeByteLength(message) > MAX_ENVELOPE_BYTES) return;
    const decoded = decodeEnvelope(message as ArrayBuffer | ArrayBufferView);
    if (!decoded) return;
    const row = this.loadRow();
    if (!row || row.state === "ended" || Date.now() >= this.sessionDeadline(row)) return;

    if (!betaMessageAllowed(decoded, this.readBetaFeatures())) return;
    const sender = this.roleOf(connection);
    // Frames and audio are agent → browser only. Input is browser → agent.
    // Unknown kinds are already dropped by decodeEnvelope.
    if ((decoded.kind === "frame" || decoded.kind === "audio") && sender !== "agent") return;
    if (decoded.kind === "input" && sender !== "browser") return;

    // Option A: resolve Worker askAgent* waits from agent frame JSON even when
    // no browser is joined (HTTP list/get must not require browser↔agent forward).
    if (decoded.kind === "frame" && sender === "agent") {
      this.maybeResolveFilesAsk(decoded.payload);
    }

    // Browser↔agent relay still requires both roles (inbox stash + forward).
    if (!this.hasRole("browser") || !this.hasRole("agent")) return;

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
    await this.handlePeerDisconnect(connection);
  }

  async onError(connection: Connection<ConnState>, _error: unknown): Promise<void> {
    await this.handlePeerDisconnect(connection);
  }

  /** Browser absence gets a durable grace deadline; PC interruption remains recoverable. */
  private async handlePeerDisconnect(connection: Connection<ConnState>): Promise<void> {
    if (this.tearingDown || !this.loadRow() || !this.isJoined(connection)) return;
    const role = this.roleOf(connection);
    connection.serializeAttachment({ role, joined: false });
    if (role === "agent") this.rejectAllFilesAsks({ ok: false, error: "agent_unavailable" });
    if (role === "browser" && !this.hasRole("browser")) {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO browser_absence (id,deadline) VALUES (1,?)", Date.now()+15000);
    }
    await this.persistPairState();
    this.broadcastStatus();
  }

  private sessionDeadline(row: SessionRow): number {
    const absence=this.ctx.storage.sql.exec<{deadline:number}>("SELECT deadline FROM browser_absence WHERE id=1").toArray()[0];
    return Math.min(row.expires_at,absence?.deadline ?? row.expires_at);
  }

  async onAlarm(): Promise<void> {
    const row = this.loadRow();
    if (!row) return;
    // A queued/retried old alarm must not end a successfully renewed session.
    if (this.sessionDeadline(row) > Date.now()) {
      await this.ctx.storage.setAlarm(this.sessionDeadline(row));
      return;
    }
    await this.teardown();
  }


  /** Authorize browser or agent hop token for HTTP file APIs. */
  async authorizeSessionToken(token: string): Promise<Role | null> {
    const row = this.loadRow();
    if (!row || row.state === "ended") return null;
    if (Date.now() >= this.sessionDeadline(row)) return null;
    if (timingSafeEqual(token, row.browser_token)) return "browser";
    if (timingSafeEqual(token, row.agent_token)) return "agent";
    return null;
  }

  /**
   * Option A: ask the joined agent for a PC folder listing.
   * Browser connection is optional — sends kind 0x02 directly to agent sockets.
   */
  async askAgentFilesList(path = ""): Promise<AgentFilesListResult> {
    if (!isSafeFilesPath(path, true)) return { ok: false, error: "bad_name" };
    if (!this.hasRole("agent")) {
      return { ok: false, error: "agent_unavailable" };
    }
    const key = "filesList:" + path;
    const wait = this.waitFilesAsk<AgentFilesListResult>(key, FILES_ASK_TIMEOUT_MS);
    if (!this.sendInputToAgents(encodeFilesListRequest(path))) {
      this.cancelFilesAsk(key, { ok: false, error: "agent_unavailable" });
      return wait;
    }
    return wait;
  }

  /**
   * Option A: ask the joined agent for one relative path under the PC folder root.
   * Browser connection is optional — sends kind 0x02 directly to agent sockets.
   */
  async askAgentFilesGet(name: string): Promise<AgentFilesGetResult> {
    if (!isSafeFilesPath(name)) {
      return { ok: false, error: "bad_name" };
    }
    if (!this.hasRole("agent")) {
      return { ok: false, error: "agent_unavailable" };
    }
    const key = "filesGet:" + name;
    const wait = this.waitFilesAsk<AgentFilesGetResult>(key, FILES_ASK_TIMEOUT_MS);
    if (!this.sendInputToAgents(encodeFilesGetRequest(name))) {
      this.cancelFilesAsk(key, { ok: false, error: "agent_unavailable" });
      return wait;
    }
    return wait;
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

  private async handleJoin(connection: Connection<ConnState>, message: string): Promise<void> {
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
    if (Date.now() >= this.sessionDeadline(row)) {
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
    await this.persistPairState();
    this.broadcastStatus();
  }

  private denyJoin(request: Request): Response | null {
    const row = this.loadRow();
    if (!row || row.state === "ended") {
      return jsonError("session not found", 404);
    }
    if (Date.now() >= this.sessionDeadline(row)) {
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

  private async persistPairState(): Promise<void> {
    const row = this.loadRow();
    if (!row || row.state === "ended") return;
    if(this.hasRole("browser")) this.ctx.storage.sql.exec("DELETE FROM browser_absence WHERE id=1");
    await this.ctx.storage.setAlarm(this.sessionDeadline(row));
    const paired = this.hasRole("browser") && this.hasRole("agent");
    const next = paired ? "paired" : "waiting";
    if (row.state !== next) {
      this.ctx.storage.sql.exec("UPDATE session SET state = ?", next);
    }
  }

  private readBetaFeatures(): BetaFeatures {
    const row = this.ctx.storage.sql.exec<{printing:number;microphone:number}>("SELECT printing, microphone FROM session_features LIMIT 1").toArray()[0];
    return {printingBeta:row?.printing === 1, microphoneBeta:row?.microphone === 1};
  }

  private broadcastStatus(): void {
    const status = this.snapshot();
    if (!status) return;
    this.broadcast(JSON.stringify({ type: "status", ...status, betaFeatures: this.readBetaFeatures() }));
  }

  private snapshot(): PublicStatus | null {
    const row = this.loadRow();
    if (!row || row.state === "ended") return null;
    const browserConnected = this.hasRole("browser");
    const agentConnected = this.hasRole("agent");
    const expired = Date.now() >= this.sessionDeadline(row);
    return {
      sessionId: row.id,
      state: expired ? "expired" : browserConnected && agentConnected ? "paired" : "waiting",
      expiresAt: row.expires_at,
      sessionStartedAt: row.created_at,
      browserConnected,
      agentConnected,
    };
  }



  private sendInputToAgents(payloadJson: string): boolean {
    const envelope = encodeEnvelope("input", payloadJson);
    let sent = false;
    for (const peer of this.getConnections<ConnState>("agent")) {
      if (!this.isJoined(peer)) continue;
      peer.send(envelope);
      sent = true;
    }
    return sent;
  }

  private waitFilesAsk<T>(key: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.filesAskPending.get(key);
        if (!waiters) return;
        const next = waiters.filter((w) => w.timer !== timer);
        if (next.length === 0) this.filesAskPending.delete(key);
        else this.filesAskPending.set(key, next);
        resolve({ ok: false, error: "timeout" } as T);
      }, timeoutMs);
      const waiter: FilesAskWaiter = { resolve: resolve as (value: unknown) => void, timer };
      const existing = this.filesAskPending.get(key);
      if (existing) existing.push(waiter);
      else this.filesAskPending.set(key, [waiter]);
    });
  }

  private cancelFilesAsk(key: string, value: unknown): void {
    const waiters = this.filesAskPending.get(key);
    if (!waiters || waiters.length === 0) return;
    this.filesAskPending.delete(key);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(value);
    }
  }

  private rejectAllFilesAsks(value: unknown): void {
    const keys = [...this.filesAskPending.keys()];
    for (const key of keys) this.cancelFilesAsk(key, value);
  }

  private maybeResolveFilesAsk(payload: Uint8Array): void {
    const list = filesListFromFrame(payload);
    if (list) {
      this.cancelFilesAsk("filesList:" + list.path, { ok: true, path: list.path, files: list.files });
      return;
    }
    const get = filesGetFromFrame(payload);
    if (!get) return;
    const key = "filesGet:" + get.name;
    if ("error" in get) {
      this.cancelFilesAsk(key, { ok: false, error: get.error });
      return;
    }
    try {
      const bin = Uint8Array.from(atob(get.data), (c) => c.charCodeAt(0));
      const copy = new Uint8Array(bin.byteLength);
      copy.set(bin);
      this.cancelFilesAsk(key, {
        ok: true,
        name: get.name,
        mime: get.mime,
        data: copy.buffer,
      });
    } catch {
      this.cancelFilesAsk(key, { ok: false, error: "unavailable" });
    }
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

  async endOwnedSession(browserToken: string): Promise<204 | 403 | 404> {
    const row = this.loadRow();
    if (!row || row.state === "ended") return 404;
    if (!timingSafeEqual(browserToken, row.browser_token)) return 403;
    // Check and mark ended in the same turn. A retained, expired owner may still
    // clean up its session, but agent and other-session tokens cannot end it.
    await this.teardown();
    return 204;
  }

  private async teardown(): Promise<void> {
    if (this.tearingDown) return;
    this.tearingDown = true;
    this.rejectAllFilesAsks({ ok: false, error: "agent_unavailable" });
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
  return clampTtlSeconds(ttl, DEFAULT_TTL_SECONDS);
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
