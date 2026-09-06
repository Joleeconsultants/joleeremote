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

  it("tears down when the agent disconnects and rejects later browser joins", async () => {
    const minted = await mint();
    const browser = await openWs(browserJoinPath(minted.sessionId, minted.browserToken));
    const agent = await openWs(minted.joins.agent);
    await waitUntilState(minted.sessionId, "paired");

    const browserEnded = new Promise<number>((resolve) => {
      browser.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });

    agent.close(1000, "agent gone");
    const browserCode = await browserEnded;
    expect(browserCode).toBe(4000);

    const statusRes = await SELF.fetch("https://example.com/sessions/" + minted.sessionId);
    expect(statusRes.status).toBe(404);

    const join = await SELF.fetch(
      "https://example.com" + browserJoinPath(minted.sessionId, minted.browserToken),
      { headers: { Upgrade: "websocket" } },
    );
    expect(join.status).toBe(404);
    expect(join.webSocket).toBeNull();
  });
});
