import {
  env,
  SELF,
  runDurableObjectAlarm,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope, MAX_ENVELOPE_BYTES } from "../src/envelope";
import { agentJoinPath, browserJoinPath, viewerPath } from "../src/joins";
import { Session } from "../src/session";

type Minted = {
  sessionId: string;
  browserToken: string;
  agentToken: string;
  expiresAt: number;
  ttlSeconds: number;
  joins: { browser: string; agent: string };
};

async function mint(ttlSeconds = 900): Promise<Minted> {
  const res = await SELF.fetch("https://example.com/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ttlSeconds }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Minted;
}

async function openWs(
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<WebSocket> {
  const res = await SELF.fetch("https://example.com" + path, {
    headers: { Upgrade: "websocket", ...extraHeaders },
  });
  const ws = res.webSocket;
  if (!ws) {
    const text = await res.text();
    throw new Error("expected websocket, got " + res.status + " " + text);
  }
  ws.accept();
  ws.binaryType = "arraybuffer";
  return ws;
}

function waitBinary(ws: WebSocket, timeoutMs = 8000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for binary")), timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      const data = event.data;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      if (bytes.byteLength < 2) return;
      resolve(bytes);
    };
    ws.addEventListener("message", onMessage);
  });
}

function waitStatus(ws: WebSocket, state: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for status " + state)), timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const parsed = JSON.parse(event.data) as { type?: string; state?: string };
      if (parsed.type === "status" && parsed.state === state) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

async function waitUntilState(sessionId: string, state: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await SELF.fetch("https://example.com/sessions/" + sessionId);
    if (res.ok) {
      const body = (await res.json()) as { state?: string };
      if (body.state === state) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for http status " + state);
}

describe("session hop", () => {
  it("only the owning browser token ends a session and retires both peers", async () => {
    const minted = await mint();
    const other = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs(agentJoinPath(minted.sessionId, minted.agentToken));
    await waitUntilState(minted.sessionId, "paired");
    const path = "https://example.com/sessions/" + minted.sessionId + "/end";
    const end = (token?: string) => SELF.fetch(path, { method: "POST", headers: token ? { authorization: "Bearer " + token } : {} });
    expect((await end()).status).toBe(401);
    expect((await end(minted.agentToken)).status).toBe(403);
    expect((await end(other.browserToken)).status).toBe(403);
    expect((await SELF.fetch(path + "?token=" + minted.browserToken, { method: "POST" })).status).toBe(401);
    expect((await SELF.fetch(path, { headers: { authorization: "Bearer " + minted.browserToken } })).status).not.toBe(204);
    await waitUntilState(minted.sessionId, "paired");
    const closed = [browser, agent].map(ws => new Promise<number>(resolve => ws.addEventListener("close", ev => resolve(ev.code), { once: true })));
    const ended = await end(minted.browserToken);
    expect(ended.status).toBe(204);
    expect(ended.headers.get("cache-control")).toBe("no-store");
    expect(await Promise.all(closed)).toEqual([4000, 4000]);
    expect((await SELF.fetch("https://example.com/sessions/" + minted.sessionId)).status).toBe(404);
    expect((await end(minted.browserToken)).status).toBe(404);
    await runInDurableObject(env.Session.getByName(minted.sessionId), async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    const rejoin = await SELF.fetch("https://example.com" + browserJoinPath(minted.sessionId, minted.browserToken), { headers: { Upgrade: "websocket" } });
    expect(rejoin.status).toBe(404);
    expect((await SELF.fetch("https://example.com/sessions/" + other.sessionId)).status).toBe(200);
    await SELF.fetch("https://example.com/sessions/" + other.sessionId + "/end", { method: "POST", headers: { authorization: "Bearer " + other.browserToken } });
  });

  it("allows the owning browser to clean up a retained expired session", async () => {
    const minted = await mint();
    await runInDurableObject(env.Session.getByName(minted.sessionId), async (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET expires_at = ?", Date.now() - 1);
    });
    const result = await SELF.fetch("https://example.com/sessions/" + minted.sessionId + "/end", {
      method: "POST", headers: { authorization: "Bearer " + minted.browserToken },
    });
    expect(result.status).toBe(204);
  });

  it("mints a session with join tokens and hides tokens from status", async () => {
    const minted = await mint();
    expect(minted.sessionId.length).toBe(36);
    expect(minted.browserToken).toHaveLength(64);
    expect(minted.agentToken).toHaveLength(64);
    expect(minted.browserToken).not.toBe(minted.agentToken);
    expect(minted.joins.agent).toBe(agentJoinPath(minted.sessionId, minted.agentToken));
    expect(minted.joins.browser).toBe(
      viewerPath(minted.sessionId, minted.browserToken, "example.com"),
    );
    expect(minted.joins.browser).toContain("#token=" + minted.browserToken);
    expect(minted.joins.browser).not.toMatch(/[?&]token=/);

    const statusRes = await SELF.fetch("https://example.com/sessions/" + minted.sessionId);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as Record<string, unknown>;
    expect(status.state).toBe("waiting");
    expect(status.sessionId).toBe(minted.sessionId);
    expect(JSON.stringify(status)).not.toContain(minted.browserToken);
    expect(JSON.stringify(status)).not.toContain(minted.agentToken);
    expect(status).not.toHaveProperty("browserToken");
    expect(status).not.toHaveProperty("agentToken");
  });

  it("pairs one browser and one agent and echoes opaque frame and input", async () => {
    const minted = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "paired");

    const frame = encodeEnvelope("frame", new Uint8Array([9, 8, 7, 6]));
    agent.send(frame);
    const toBrowser = decodeEnvelope(await waitBinary(browser));
    expect(toBrowser?.kind).toBe("frame");
    expect(Array.from(toBrowser?.payload ?? [])).toEqual([9, 8, 7, 6]);

    const input = encodeEnvelope("input", new Uint8Array([1, 2, 3]));
    browser.send(input);
    const toAgent = decodeEnvelope(await waitBinary(agent));
    expect(toAgent?.kind).toBe("input");
    expect(Array.from(toAgent?.payload ?? [])).toEqual([1, 2, 3]);

    const audio = encodeEnvelope("audio", new Uint8Array([4, 5, 6]));
    agent.send(audio);
    const toBrowserAudio = decodeEnvelope(await waitBinary(browser));
    expect(toBrowserAudio?.kind).toBe("audio");
    expect(Array.from(toBrowserAudio?.payload ?? [])).toEqual([4, 5, 6]);

    browser.close(1000, "done");
    agent.close(1000, "done");
  });

  it("forwards audio only agent to browser and drops unknown kinds", async () => {
    const minted = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "paired");

    browser.send(encodeEnvelope("audio", new Uint8Array([99])));
    const input = encodeEnvelope("input", new Uint8Array([7, 7]));
    browser.send(input);
    const toAgent = decodeEnvelope(await waitBinary(agent));
    expect(toAgent?.kind).toBe("input");
    expect(Array.from(toAgent?.payload ?? [])).toEqual([7, 7]);

    agent.send(new Uint8Array([1, 0x99, 1, 2, 3]));
    const small = encodeEnvelope("frame", new Uint8Array([5]));
    agent.send(small);
    const later = decodeEnvelope(await waitBinary(browser));
    expect(later?.kind).toBe("frame");
    expect(Array.from(later?.payload ?? [])).toEqual([5]);

    browser.close(1000, "done");
    agent.close(1000, "done");
  });

  it("rejects a second browser and a second agent", async () => {
    const minted = await mint();
    const browserPath = browserJoinPath(minted.sessionId, minted.browserToken);
    const browser = await openWs(browserPath);
    await waitStatus(browser, "waiting");

    const secondBrowser = await SELF.fetch("https://example.com" + browserPath, {
      headers: { Upgrade: "websocket" },
    });
    expect(secondBrowser.status).toBe(409);
    expect(secondBrowser.webSocket).toBeNull();

    const agent = await openWs(minted.joins.agent);
    await waitStatus(agent, "paired");

    const secondAgent = await SELF.fetch("https://example.com" + minted.joins.agent, {
      headers: { Upgrade: "websocket" },
    });
    expect(secondAgent.status).toBe(409);
    expect(secondAgent.webSocket).toBeNull();

    browser.close(1000, "done");
    agent.close(1000, "done");
  });

  it("tears down on TTL alarm and rejects later joins", async () => {
    const minted = await mint(60);
    const stub = env.Session.getByName(minted.sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE session SET expires_at = ?', Date.now() - 1);
    });
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const statusRes = await SELF.fetch("https://example.com/sessions/" + minted.sessionId);
    expect(statusRes.status).toBe(404);

    const join = await SELF.fetch(
      "https://example.com" + browserJoinPath(minted.sessionId, minted.browserToken),
      {
        headers: { Upgrade: "websocket" },
      },
    );
    expect(join.status).toBe(404);
    expect(join.webSocket).toBeNull();
  });

  it("keeps connection tags across wake so frame routing still works", async () => {
    const minted = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "paired");

    const stub = env.Session.getByName(minted.sessionId);
    await runInDurableObject(stub, (instance: Session) => {
      expect([...instance.getConnections("browser")]).toHaveLength(1);
      expect([...instance.getConnections("agent")]).toHaveLength(1);
    });

    await evictDurableObject(stub);

    const frame = encodeEnvelope("frame", new Uint8Array([42]));
    agent.send(frame);
    const toBrowser = decodeEnvelope(await waitBinary(browser));
    expect(toBrowser?.kind).toBe("frame");
    expect(Array.from(toBrowser?.payload ?? [])).toEqual([42]);

    browser.close(1000, "done");
    agent.close(1000, "done");
  });

  it("requires mint secret when configured and accepts Bearer or X-Mint-Secret", async () => {
    const previous = env.MINT_SECRET;
    env.MINT_SECRET = "unit-test-mint-secret";
    try {
      const denied = await SELF.fetch("https://example.com/sessions", { method: "POST" });
      expect(denied.status).toBe(401);

      const wrong = await SELF.fetch("https://example.com/sessions", {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);

      const okBearer = await SELF.fetch("https://example.com/sessions", {
        method: "POST",
        headers: { Authorization: "Bearer unit-test-mint-secret" },
      });
      expect(okBearer.status).toBe(201);

      const okHeader = await SELF.fetch("https://example.com/sessions", {
        method: "POST",
        headers: { "X-Mint-Secret": "unit-test-mint-secret" },
      });
      expect(okHeader.status).toBe(201);
    } finally {
      env.MINT_SECRET = previous;
    }
  });

  it("joins with first-message token and query-string fallback", async () => {
    const minted = await mint();
    const browser = await openWs("/sessions/" + minted.sessionId + "/browser");
    browser.send(JSON.stringify({ type: "join", token: minted.browserToken }));
    await waitStatus(browser, "waiting");

    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "paired");

    const frame = encodeEnvelope("frame", new Uint8Array([7]));
    agent.send(frame);
    const toBrowser = decodeEnvelope(await waitBinary(browser));
    expect(Array.from(toBrowser?.payload ?? [])).toEqual([7]);

    browser.close(1000, "done");
    agent.close(1000, "done");
  });

  it("joins agent with Authorization Bearer and no query token", async () => {
    const minted = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs("/sessions/" + minted.sessionId + "/agent", {
      Authorization: "Bearer " + minted.agentToken,
    });
    await waitUntilState(minted.sessionId, "paired");
    browser.close(1000, "done");
    agent.close(1000, "done");
  });

  it("drops oversize envelopes and still forwards a later in-cap frame", async () => {
    const minted = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "paired");

    const oversize = encodeEnvelope("frame", new Uint8Array(MAX_ENVELOPE_BYTES));
    expect(oversize.byteLength).toBeGreaterThan(MAX_ENVELOPE_BYTES);
    agent.send(oversize);
    const small = encodeEnvelope("frame", new Uint8Array([3, 3, 3]));
    agent.send(small);
    const toBrowser = decodeEnvelope(await waitBinary(browser));
    expect(toBrowser?.kind).toBe("frame");
    expect(Array.from(toBrowser?.payload ?? [])).toEqual([3, 3, 3]);

    browser.close(1000, "done");
    agent.close(1000, "done");
  });

  it("keeps the session alive on browser refresh so the same id can resume", async () => {
    const minted = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "paired");

    const agentEnded = new Promise<{ code: number }>((resolve) => {
      agent.addEventListener("close", (ev) => resolve({ code: ev.code }), { once: true });
    });

    browser.close(1000, "refresh");
    await waitUntilState(minted.sessionId, "waiting");

    const statusRes = await SELF.fetch("https://example.com/sessions/" + minted.sessionId);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      state?: string;
      browserConnected?: boolean;
      agentConnected?: boolean;
    };
    expect(status.state).toBe("waiting");
    expect(status.browserConnected).toBe(false);
    expect(status.agentConnected).toBe(true);

    // Agent must stay up — teardown would close it with 4000.
    await expect(
      Promise.race([
        agentEnded.then((c) => {
          throw new Error("agent closed unexpectedly with " + c.code);
        }),
        new Promise((resolve) => setTimeout(resolve, 150)),
      ]),
    ).resolves.toBeUndefined();

    const browser2 = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    await waitUntilState(minted.sessionId, "paired");

    const frame = encodeEnvelope("frame", new Uint8Array([11, 22]));
    agent.send(frame);
    const toBrowser = decodeEnvelope(await waitBinary(browser2));
    expect(toBrowser?.kind).toBe("frame");
    expect(Array.from(toBrowser?.payload ?? [])).toEqual([11, 22]);

    browser2.close(1000, "done");
    agent.close(1000, "done");
  });

  it("agent loss preserves the browser and original deadline for recovery", async () => {
    const minted=await mint();
    const browser=await openWs(browserJoinPath(minted.sessionId,minted.browserToken));
    const agent=await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId,"paired");agent.close();
    const waiting=await waitUntilState(minted.sessionId,"waiting");
    expect(waiting.browserConnected).toBe(true);expect(waiting.expiresAt).toBe(minted.expiresAt);
    const stub=env.Session.getByName(minted.sessionId);
    await runInDurableObject(stub,async(instance:Session,state)=>{
      expect(state.storage.sql.exec("SELECT * FROM browser_absence").toArray()).toHaveLength(0);
      await instance.onAlarm();expect((await instance.status())?.browserConnected).toBe(true);
    });
    const agent2=await openWs(minted.joins.agent);await waitUntilState(minted.sessionId,"paired");
    browser.close();agent2.close();
  });

  it("browser absence expires after persisted grace and rejects a late refresh",async()=>{
    const minted=await mint();const browser=await openWs(browserJoinPath(minted.sessionId,minted.browserToken));
    browser.close();await waitUntilState(minted.sessionId,"waiting");
    const stub=env.Session.getByName(minted.sessionId);
    await runInDurableObject(stub,async(instance:Session,state)=>{
      const rows=state.storage.sql.exec<{deadline:number}>("SELECT deadline FROM browser_absence").toArray();
      expect(rows).toHaveLength(1);expect(rows[0].deadline-Date.now()).toBeGreaterThan(14000);
      expect(await state.storage.getAlarm()).toBe(rows[0].deadline);
      state.storage.sql.exec("UPDATE browser_absence SET deadline=?",Date.now()-1);
      await instance.onAlarm();expect(await instance.status()).toBeNull();
    });
    expect((await SELF.fetch("https://example.com"+browserJoinPath(minted.sessionId,minted.browserToken),{headers:{Upgrade:"websocket"}})).status).toBe(404);
  });

  it("refresh cancels persisted grace without extending original expiry",async()=>{
    const minted=await mint();const browser=await openWs(browserJoinPath(minted.sessionId,minted.browserToken));browser.close();
    await waitUntilState(minted.sessionId,"waiting");
    const stub=env.Session.getByName(minted.sessionId);
    await evictDurableObject(stub);
    const next=await openWs(browserJoinPath(minted.sessionId,minted.browserToken));
    await runInDurableObject(stub,async(instance:Session,state)=>{
      expect(state.storage.sql.exec("SELECT * FROM browser_absence").toArray()).toHaveLength(0);
      expect(await state.storage.getAlarm()).toBe(minted.expiresAt);
      await instance.onAlarm();expect((await instance.status())?.expiresAt).toBe(minted.expiresAt);
    });next.close();
  });

  it("askAgentFilesList talks to agent without a browser and resolves the frame reply", async () => {
    const minted = await mint();
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "waiting");

    const stub = env.Session.getByName(minted.sessionId);
    const askPromise = runInDurableObject(stub, (instance: Session) =>
      instance.askAgentFilesList(),
    );

    const req = decodeEnvelope(await waitBinary(agent));
    expect(req?.kind).toBe("input");
    expect(new TextDecoder().decode(req?.payload ?? new Uint8Array())).toBe(
      '{"t":"filesList"}',
    );

    agent.send(
      encodeEnvelope(
        "frame",
        JSON.stringify({
          t: "filesList",
          files: [{ name: "note.txt", size: 4, mtime: 1_700_000_000_000 }],
        }),
      ),
    );

    const result = await askPromise;
    expect(result).toEqual({
      ok: true,
      path: "",
      files: [{ id: "note.txt", name: "note.txt", type: "file", size: 4, mtime: 1_700_000_000_000 }],
    });

    agent.close(1000, "done");
  });

  it("askAgentFilesGet returns agent bytes and rejects unsafe basenames", async () => {
    const minted = await mint();
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "waiting");
    const stub = env.Session.getByName(minted.sessionId);

    const bad = await runInDurableObject(stub, (instance: Session) =>
      instance.askAgentFilesGet("../secret"),
    );
    expect(bad).toEqual({ ok: false, error: "bad_name" });

    const askPromise = runInDurableObject(stub, (instance: Session) =>
      instance.askAgentFilesGet("note.txt"),
    );
    const req = decodeEnvelope(await waitBinary(agent));
    expect(req?.kind).toBe("input");
    expect(new TextDecoder().decode(req?.payload ?? new Uint8Array())).toBe(
      '{"t":"filesGet","name":"note.txt"}',
    );

    agent.send(
      encodeEnvelope(
        "frame",
        JSON.stringify({
          t: "filesGet",
          name: "note.txt",
          mime: "text/plain",
          data: btoa("hi"),
        }),
      ),
    );
    const result = await askPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("note.txt");
      expect(result.mime).toBe("text/plain");
      expect(Array.from(new Uint8Array(result.data))).toEqual([104, 105]);
    }

    agent.close(1000, "done");
  });

  it("askAgentFilesList returns agent_unavailable when no agent is joined", async () => {
    const minted = await mint();
    const stub = env.Session.getByName(minted.sessionId);
    const result = await runInDurableObject(stub, (instance: Session) =>
      instance.askAgentFilesList(),
    );
    expect(result).toEqual({ ok: false, error: "agent_unavailable" });
  });

});

describe("public PC files HTTP", () => {
  function filesUrl(m: Minted, path = "", query = "") {
    return `https://example.com/api/files/${path}?session=${m.sessionId}&token=${m.browserToken}${query}`;
  }
  function reply(agent: WebSocket, body: unknown) {
    agent.send(encodeEnvelope("frame", JSON.stringify(body)));
  }
  async function requestFrame(agent: WebSocket) {
    const frame = decodeEnvelope(await waitBinary(agent));
    expect(frame?.kind).toBe("input");
    return JSON.parse(new TextDecoder().decode(frame!.payload));
  }

  it("browses root and nested folders with stock shell, cookies, and JSON", async () => {
    const m = await mint();
    const agent = await openWs(m.joins.agent);
    const root = SELF.fetch(filesUrl(m));
    expect(await requestFrame(agent)).toEqual({ t: "filesList" });
    reply(agent, { t: "filesList", path: "", files: [{ id: "a & b", name: "a & b", type: "dir", size: 0, mtime: 0 }] });
    const response = await root;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const html = await response.text();
    expect(html).toContain('id="list"');
    expect(html).toContain('href="a%20%26%20b/"');
    expect(html).toContain('href="../"');
    expect(html).toContain("parentRow.style.display = 'none'");
    expect(html).toContain('/api/files/</h1>');
    const cookie = `jolee_session=${m.sessionId}; jolee_browser_token=${m.browserToken}`;
    const nested = SELF.fetch("https://example.com/api/files/a%20%26%20b/", { headers: { cookie } });
    expect(await requestFrame(agent)).toEqual({ t: "filesList", path: "a & b" });
    const file = { id: "a & b/report.txt", name: "report.txt", type: "file", size: 2, mtime: 0 };
    reply(agent, { t: "filesList", path: "a & b", files: [file] });
    const nestedHtml = await (await nested).text();
    expect(nestedHtml).toContain('/api/files/a &amp; b/</h1>');
    expect(nestedHtml).toContain('href="report.txt"');
    const json = SELF.fetch(filesUrl(m, "a%20%26%20b/", "&format=json"));
    expect(await requestFrame(agent)).toEqual({ t: "filesList", path: "a & b" });
    reply(agent, { t: "filesList", path: "a & b", files: [file] });
    expect(await (await json).json()).toEqual({ sessionId: m.sessionId, source: "pc", path: "a & b", files: [file] });
    agent.close();
  });

  it("correlates simultaneous folders independently, including legacy root replies", async () => {
    const m = await mint();
    const agent = await openWs(m.joins.agent);
    const root = SELF.fetch(filesUrl(m, "", "&format=json"));
    expect(await requestFrame(agent)).toEqual({ t: "filesList" });
    const nested = SELF.fetch(filesUrl(m, "a/", "&format=json"));
    expect(await requestFrame(agent)).toEqual({ t: "filesList", path: "a" });
    reply(agent, { t: "filesList", path: "a", files: [] });
    expect(await (await nested).json()).toMatchObject({ path: "a" });
    reply(agent, { t: "filesList", files: [] });
    expect(await (await root).json()).toMatchObject({ path: "" });
    agent.close();
  });

  it("downloads a nested ID with Bearer auth and attachment disposition", async () => {
    const m = await mint();
    const agent = await openWs(m.joins.agent);
    const download = SELF.fetch(`https://example.com/api/files/a/report.txt?session=${m.sessionId}`, { headers: { authorization: `Bearer ${m.browserToken}` } });
    expect(await requestFrame(agent)).toEqual({ t: "filesGet", name: "a/report.txt" });
    reply(agent, { t: "filesGet", name: "a/report.txt", mime: "text/plain", data: btoa("hi") });
    const response = await download;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain('attachment; filename="report.txt"');
    expect(await response.text()).toBe("hi");
    agent.close();
  });

  it("times out a folder ask when the agent replies for another path", async () => {
    const m = await mint();
    const agent = await openWs(m.joins.agent);
    const listing = SELF.fetch(filesUrl(m, "a/", "&format=json"));
    expect(await requestFrame(agent)).toEqual({ t: "filesList", path: "a" });
    reply(agent, { t: "filesList", path: "other", files: [] });
    const response = await listing;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "timeout" });
    agent.close();
  });

  it("rejects expired credentials before asking the agent", async () => {
    const m = await mint();
    const stub = env.Session.getByName(m.sessionId);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET expires_at = ?", Date.now() - 1);
    });
    expect((await SELF.fetch(filesUrl(m))).status).toBe(403);
  });

  it.each([["not_found", 404], ["too_large", 413], ["unavailable", 503]] as const)("maps agent %s", async (error, status) => {
    const m = await mint();
    const agent = await openWs(m.joins.agent);
    const download = SELF.fetch(filesUrl(m, "a/report.txt"));
    await requestFrame(agent);
    reply(agent, { t: "filesGet", name: "a/report.txt", error });
    expect((await download).status).toBe(status);
    agent.close();
  });

  it("rejects missing, stale and wrong credentials and handles unpaired sessions", async () => {
    const m = await mint();
    expect((await SELF.fetch("https://example.com/api/files/")).status).toBe(401);
    expect((await SELF.fetch(filesUrl(m).replace(m.browserToken, "wrong"))).status).toBe(403);
    expect((await SELF.fetch(`https://example.com/api/files/?session=${m.sessionId}`, { headers: { cookie: `jolee_session=old; jolee_browser_token=${m.browserToken}` } })).status).toBe(401);
    expect((await SELF.fetch(filesUrl(m))).status).toBe(503);
    expect((await SELF.fetch(filesUrl(m), { method: "POST" })).status).toBe(405);
    const redirect = await SELF.fetch(filesUrl(m).replace("/files/?", "/files?"), { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toContain("/api/files/?");
  });

  it.each(["a%2f..%2fb", "a//b/", "%5cb", "C%3a/a", "a%00", "CON.txt", "a.%20/", "%ZZ", "/"])("rejects unsafe HTTP path %s", async (path) => {
    const m = await mint();
    expect((await SELF.fetch(filesUrl(m, path))).status).toBe(400);
  });
});
