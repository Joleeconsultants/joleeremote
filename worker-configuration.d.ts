interface Env {
  Session: DurableObjectNamespace<import("./src/session").Session>;
  ASSETS?: Fetcher;
  MINT_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
}

declare namespace Cloudflare {
  interface Env {
    Session: DurableObjectNamespace<import("./src/session").Session>;
    ASSETS?: Fetcher;
    MINT_SECRET?: string;
    SESSION_TTL_SECONDS?: string;
  }
}
