import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  clampTtlSeconds,
  resolveSessionTtlSeconds,
} from "../src/types";

describe("SESSION_TTL_SECONDS resolve/clamp", () => {
  it("uses DEFAULT_TTL_SECONDS when env unset or empty", () => {
    expect(resolveSessionTtlSeconds(undefined)).toBe(DEFAULT_TTL_SECONDS);
    expect(resolveSessionTtlSeconds("")).toBe(DEFAULT_TTL_SECONDS);
    expect(resolveSessionTtlSeconds("  ")).toBe(DEFAULT_TTL_SECONDS);
  });

  it("parses env and clamps to MIN/MAX", () => {
    expect(resolveSessionTtlSeconds("900")).toBe(900);
    expect(resolveSessionTtlSeconds("3600")).toBe(3600);
    expect(resolveSessionTtlSeconds("1")).toBe(MIN_TTL_SECONDS);
    expect(resolveSessionTtlSeconds("0")).toBe(MIN_TTL_SECONDS);
    expect(resolveSessionTtlSeconds("-5")).toBe(MIN_TTL_SECONDS);
    expect(resolveSessionTtlSeconds("99999")).toBe(MAX_TTL_SECONDS);
    expect(resolveSessionTtlSeconds("900.9")).toBe(900);
  });

  it("falls back on non-numeric env", () => {
    expect(resolveSessionTtlSeconds("nope")).toBe(DEFAULT_TTL_SECONDS);
    expect(resolveSessionTtlSeconds("NaN")).toBe(DEFAULT_TTL_SECONDS);
  });

  it("clampTtlSeconds clamps overrides and uses fallback", () => {
    expect(clampTtlSeconds(undefined, 1200)).toBe(1200);
    expect(clampTtlSeconds(60, 900)).toBe(60);
    expect(clampTtlSeconds(0, 900)).toBe(MIN_TTL_SECONDS);
    expect(clampTtlSeconds(99999, 900)).toBe(MAX_TTL_SECONDS);
  });
});

describe("mint TTL from env default / body override", () => {
  it("mints with wrangler SESSION_TTL_SECONDS default when body omits ttlSeconds", async () => {
    const res = await SELF.fetch("https://example.com/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ttlSeconds: number };
    expect(body.ttlSeconds).toBe(3600);
  });

  it("mints with default when no JSON body", async () => {
    const res = await SELF.fetch("https://example.com/sessions", { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ttlSeconds: number };
    expect(body.ttlSeconds).toBe(3600);
  });

  it("clamps body ttlSeconds override", async () => {
    const high = await SELF.fetch("https://example.com/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 99999 }),
    });
    expect(high.status).toBe(201);
    expect(((await high.json()) as { ttlSeconds: number }).ttlSeconds).toBe(
      MAX_TTL_SECONDS,
    );

    const low = await SELF.fetch("https://example.com/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 0 }),
    });
    expect(low.status).toBe(201);
    expect(((await low.json()) as { ttlSeconds: number }).ttlSeconds).toBe(
      MIN_TTL_SECONDS,
    );

    const mid = await SELF.fetch("https://example.com/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 120 }),
    });
    expect(mid.status).toBe(201);
    expect(((await mid.json()) as { ttlSeconds: number }).ttlSeconds).toBe(120);
  });
});
