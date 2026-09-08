# Agent integration

Your backend mints a session on the hop Worker, opens the Selkies HTML URL, and your agent outbound-connects to the Worker. The hop pairs exactly one browser socket with exactly one agent socket and forwards opaque `frame` / `input` / `audio` bytes. Pairing is 1:1; N browsers is a later consumer need.

Join URL helpers live in `src/joins.ts` (`viewerPath` is the product browser join).

## Mint

Serve session HTML from any origin you control (docs placeholder: `https://remote.example.com`). Pass `hop` only when the Worker is on another host.

Your app: `POST /sessions` on the hop Worker with optional JSON `{ "ttlSeconds": 900 }` (clamped 1..3600). Default when omitted: Worker var `SESSION_TTL_SECONDS` (default `"900"`).

**Production requires a mint secret.** Set Worker env `MINT_SECRET` and send it as:

- `Authorization: Bearer <MINT_SECRET>`, or
- `X-Mint-Secret: <MINT_SECRET>`

Missing or wrong secret → `401`. Local `wrangler dev` with `MINT_SECRET` unset keeps open mint so you can iterate without a secret; production must set one (`wrangler secret put MINT_SECRET`).

Local (open mint):

```bash
curl -sS -X POST http://127.0.0.1:8787/sessions -H 'content-type: application/json' -d '{"ttlSeconds": 900}'
```

Production (Worker host, not the HTML host unless they share an origin):

```bash
curl -sS -X POST https://hop.example.com/sessions -H 'Authorization: Bearer …'
```

HTTP `201`. Example local mint body:

```json
{
  "sessionId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "browserToken": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "agentToken": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  "expiresAt": 1770000000000,
  "ttlSeconds": 900,
  "joins": {
    "browser": "/?session=3fa85f64-5717-4562-b3fc-2c963f66afa6&hop=127.0.0.1:8787#token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "agent": "/sessions/3fa85f64-5717-4562-b3fc-2c963f66afa6/agent?token=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
  }
}
```

Store `sessionId`. Response also has `browserToken`, `agentToken`, `expiresAt`, `ttlSeconds`, and `joins`:

- `joins.browser` — path on the hop Worker: `/?session=<id>&hop=<worker-host>#token=<browserToken>` (mint sets `hop` from the Worker Host). If the HTML is on another host, your app builds `https://remote.example.com/?session=<id>&hop=<worker-host>#token=<browserToken>`. Same origin: you can omit `hop`.
- `joins.agent` — agent WebSocket path with query-token fallback

## Open the session (browser)

Same origin (HTML served by the Worker):

```
https://remote.example.com/?session=<id>#token=<browserToken>
```

Split origin (HTML on `remote`, Worker elsewhere):

```
https://remote.example.com/?session=<id>&hop=<worker-host>#token=<browserToken>
```

That opens **Selkies chrome**. `hop` is the Worker host. Omit it when HTML and Worker share an origin. Mint `joins.browser` is the matching path on the Worker (`viewerPath`); if the HTML host differs, prefix `https://remote.example.com` and keep `hop`.

`/viewer.html` is the canvas hole the chrome iframes. PartySocket `/parties/session/:id?role=browser&token=` is how that hole connects, not a second product join.

## Agent join

Hand the agent `sessionId` plus the agent URL and token. Any WebSocket client (do not require PartySocket):

```
wss://<worker-host>/sessions/<id>/agent?token=<agentToken>
```

Token paths (query is fallback):

1. First text message after upgrade: `{"type":"join","token":"<agentToken>"}` on `wss://<worker-host>/sessions/<id>/agent`
2. `Authorization: Bearer <agentToken>` on the WebSocket upgrade
3. Query string `?token=` (fallback; still what `joins.agent` returns)

The agent is the WebSocket **client**. The session Durable Object is the WebSocket **server** and may hibernate. The DO never dials out.

## Pairing

Wait for a **text** JSON control message with `type: "status"` and `state: "paired"` before sending frames. Binary envelopes sent before both peers are in are dropped. 1:1 pairing only.

Shape:

`{"type":"status","sessionId":"...","state":"waiting|paired|expired","expiresAt":0,"browserConnected":true,"agentConnected":true}`

## Envelope

Every binary WebSocket message:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | version (`0x01`) |
| 1 | 1 | kind: `0x01` frame (agent → browser, H.264 or JPEG/WebP), `0x02` input (browser → agent, JSON opaque), `0x03` audio (agent → browser, complete media chunk) |
| 2.. | n | opaque payload |

No RFB. The hop does not interpret pixels, codecs, or OS events. Malformed envelopes and unknown kinds are dropped. Frames and audio only from the agent connection to the browser connection. Input only from the browser connection to the agent connection. `encodeEnvelope` / `decodeEnvelope` are in `src/envelope.ts`.

### Applying input (viewer JSON)

The hop forwards input bytes opaquely. The Selkies chrome viewer sends UTF-8 JSON in kind `input`. Honor these shapes on the device. Helpers: `parseInputPayload` / `parseInputJson` from `src/input.ts` (re-exported by `src/agent-tools.ts`); CAD spellings normalize like the viewer to `ctrl-alt-delete`.


- `{t:"pointer", e, x, y, b}` — `e` is `move` / `down` / `up`; `x`/`y` are 0–1 over the displayed image (`object-fit` contain vs stretch). `b` is `buttons` on move, `button` on down/up
- `{t:"wheel", dx, dy, x, y}` — canvas wheel; `dx`/`dy` are `deltaX`/`deltaY`; context menu is suppressed so right-click stays in the session
- `{t:"key", e, key, code}` — `e` is `down` / `up`. Keys are captured on the canvas after pointerdown focus, not from dashboard `.allow-native-input`
- `{t:"clipboard", text, id?}` — browser → agent (sidebar PC Clipboard, text). Optional correlation `id` is 1–64 characters. The current text receiver limit is 16,384 UTF-16 units, with no NUL or unpaired surrogates; never truncate.
- `{t:"clipboard", mime, data}` — browser → agent image clipboard. `mime` starts with `image/` (default `image/png`); `data` is base64. The viewer skips the send if the encoded envelope would exceed 1 MiB.
- `{t:"resize", w, h}` — set capture size from the original screen panel
- `{t:"resize", w, h, reset:true}` — reset capture size to `round(innerWidth)` / `round(innerHeight)`
- `{t:"cssScaling", value}` — HiDPI / CSS scaling (`setUseCssScaling`)
- `{t:"settings", settings}` — sidebar settings object (DPI, force aligned, …)
- `{t:"audioDevice", context, deviceId}` — original audio panel device select
- `{t:"pipeline", pipeline, enabled}` — chrome pipeline toggle (`audio` mutes playback in the viewer)
- `{t:"mic", mime, data}` — browser microphone `MediaRecorder` chunk; `data` is base64
- `{t:"file", name, mime, data}` — browser → agent upload in kind `0x02`; `data` is base64. The consumer agent writes into its PC `FileManagerPath` / Desktop root; the consumer owns path resolution.
- `{t:"webcam", mime:"image/jpeg", data}` — periodic browser webcam JPEG still; `data` is base64
- `{t:"command", command:"ctrl-alt-delete"}` — normalized secure-attention shortcut; other command payloads are forwarded
- `{t:"ping", id}` — latency probe; `id` is a nonempty string of at most 64 characters. Reply on the same paired session with a frame envelope containing `{t:"pong", id}`. Echo only the ID; do not execute input or return host information. The browser sends probes every 5 seconds with at most one pending, rejects replies after 10 seconds, and expires measured round-trip latency after 15 seconds. It measures elapsed time locally, so clocks need not be synchronized. Agents without this capability leave latency unavailable.

To fill the sidebar PC Clipboard, the agent may send a *frame* envelope whose payload is UTF-8 JSON (not pixels). The hop does not parse it; the viewer does:

- `{"t":"clipboard","text":"..."}` — posts `clipboardContentUpdate` `{text}` to the parent
- `{"t":"clipboard","mime":"image/png","data":"<base64>"}` — posts `clipboardImageUpdate` `{mime, data}` to the parent (the sidebar may ignore inbound images)

The same JSON-frame pattern carries the remote cursor *shape* (not pointer position). Overlay position follows the local pointer so it does not wait on JPEG fps; the agent supplies the bitmap + hotspot. Default overlay is a drawn arrow until a cursor frame arrives. Do not add envelope kind `0x04`.

- `{"t":"cursor","visible":true,"hx":0,"hy":1,"mime":"image/png","data":"<base64>"}` — show overlay, set hotspot (`hx`,`hy`) and swap the overlay image
- `{"t":"cursor","visible":false}` — hide the overlay
- Missing `visible` means shown. If `mime`/`data` are omitted, keep the current (or default) arrow

Pointer / key / wheel remain **input** JSON (browser → agent). Cursor JSON is a **frame** (agent → browser). CSS cursors toggle (original dashboard UI) hides the overlay and uses a normal local pointer; default is the remote overlay (`canvas.style.cursor='none'`).

An agent can send more JSON frame shapes:

- `{t:"file", name, mime, data}` — agent → browser push download (including canary) in kind `0x01`; triggers a browser download from base64 data. This is distinct from a `filesGet` response below.
- `{t:"stats", system_stats, gpu_stats, fps, network_stats, currentAudioLevel}` — optionally fill the CPU, memory, GPU, latency, and audio gauges. `system`/`gpu`/`network` and `audio_level` aliases are accepted. The viewer measures FPS and bandwidth when those fields are absent.
- `{t:"print", mime, name, data}` — finished session print job (prefer `application/pdf` after agent PostScript→PDF). Optional chunking: `job`, `part`, `parts` where each `data` is base64 of a byte slice. Viewer opens browser print preview; see [print-redirect.md](print-redirect.md).

A consumer applies pointer/key/wheel to the OS. Windows SendInput is out of this repo. Sample `examples/agent.mjs` proves the pipe + can send one cursor bitmap; it only logs input.

Image clipboard and cursor stay on input JSON / JSON frame (kind `0x02` / kind `0x01`). Do not invent extra envelope kinds except audio `0x03`: audio is a byte stream like frames, so it is its own kind. The hop does not decode codecs. The viewer plays kind `0x03` as a complete media chunk (`Blob` + `Audio`; tries `audio/webm`, `ogg`, `wav`, `mpeg`).

Frames and audio stay agent → browser. Input stays browser → agent.

### Files (locked Option A)

List/get use UTF-8 JSON inside the existing input / frame envelopes. The consumer agent applies them to its PC `FileManagerPath` / Desktop root, including uploads above. The consumer owns PC path resolution. The Session DO may correlate Worker `askAgentFilesList` / `askAgentFilesGet` RPC waits against agent frame replies (still no PC path logic in the hop); browser↔agent forward stays opaque for other payloads.

| Operation | Direction / kind | JSON payload shape |
| --- | --- | --- |
| List request | browser/Worker → agent, `0x02` input | `{"t":"filesList"}` |
| List response | agent → browser/Worker, `0x01` frame | `{"t":"filesList","files":[{"name","size","mtime"}]}` |
| Get request | browser/Worker → agent, `0x02` input | `{"t":"filesGet","name":"report.txt"}` |
| Get success | agent → browser/Worker, `0x01` frame | `{"t":"filesGet","name","mime","data"}` |
| Get error | agent → browser/Worker, `0x01` frame | `{"t":"filesGet","name","error":"not_found"\|"too_large"\|"unavailable"}` |

- Shapes use field-name shorthand where values vary. Listing is non-recursive (root only); `mtime` is Unix milliseconds UTC.
- `filesGet` accepts a basename only: no path separators (`/` or `\`) or `..`. Success `data` is base64.
- Every whole binary envelope must be ≤ **1 MiB** (`MAX_ENVELOPE_BYTES = 1048576`), including the two-byte header, JSON, and base64 expansion — the same cap as existing file pull. No new transfer protocol or envelope kinds.
- UI **Download Files** and the `letleeadmin` CLI target the same PC folder via the Worker asking the paired agent. A Session DO inbox, if a consumer uses one, is interim only; the end state is the PC folder.

### Leftover (no hop yet)

Apps and sharing have no hop yet. Gaming stays out unless asked. Encoder / video settings belong to the capture agent; there is no pixelflux on this hop.

Shipped viewer contract for session print: agent → hop → browser may send `{t:"print", mime, name, data}` (optional `job` / `part` / `parts` for chunking under the 1 MiB envelope). The viewer opens the browser print dialog / preview for PDF (and images); non-printable mime falls back to download. The **session-only virtual printer** (appear on pair, remove on teardown) and PostScript→PDF conversion stay **consumer agent** work — not in this repo. Silent OS spool is desktop-client only; the web viewer always uses the browser print UI. See [print-redirect.md](print-redirect.md). Cite IronRDP ironrdp-rdpdr for Create/Write/Close job semantics when building the consumer.

Visible chrome after this hop: screen and agent-owned encoder preference (default H.264; JPEG fallback) + frame-rate/JPEG-quality settings, PC clipboard text+image, audio playback, microphone capture, files, webcam, stats, a Ctrl+Alt+Del shortcut, fullscreen, theme, and mobile keyboard. Paint-over and other Selkies-only encoder controls remain hidden.

### Max binary message size

Cloudflare Durable Objects accept received WebSocket messages up to **32 MiB** ([platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). This hop drops envelopes larger than **1 MiB** (`MAX_ENVELOPE_BYTES = 1048576`) so JPEG/WebP stills at low fps stay inside a conservative cap. Oversize frames are not forwarded; the session stays up.

## Rejects and teardown

- `401` mint secret missing/wrong (when `MINT_SECRET` is configured)
- `403` bad join token (upgrade with query or `Authorization`)
- `404` unknown session
- `409` second peer (second browser or second agent)
- `410` expired

First-message join failures close the socket (`4003` invalid token, `4009` role already connected) instead of an HTTP status.

TTL alarm or either **joined** peer dropping ends the session. Later joins are rejected. A socket that never sent a join token does not tear the session down.


## Pairing (agent builder view)

```mermaid
flowchart LR
  Browser[Browser / Selkies viewer] <-->|opaque envelopes| Hop[Hop Worker + Session DO]
  Hop <-->|outbound WSS agent| Agent[Device agent]
```

1:1 pair only. Wait for `status` / `paired` before binary frames. Capture and inject are agent-local; the hop only forwards.

## Consumer tool map

What existing tools to use for capture, input, print, clipboard, audio, etc.: [consumer-tools.md](consumer-tools.md). Print detail: [print-redirect.md](print-redirect.md).

## What you keep vs the hop

**Hop:** mint, 1:1 pair, forward opaque envelopes, hibernate, TTL teardown.

**You keep:**
- Anything beyond the mint secret and join tokens (users, tenants, Access)
- Devices / identity / fleet agent
- Capture encoding (H.264 preferred; JPEG/WebP stills OK) — e.g. LetLeeIn / DXGI / WGC in **your** agent (not this repo)
- Applying opaque input JSON on the device (SendInput etc. stay OS-side)
- Hop wire helpers shipped here: import `src/agent-tools.ts` (parsers + frame builders). OS capture/inject/print binaries stay out.

## Host authorization (tiers)

Do not rely on Cloudflare Access policies to police who may open which PC. Access (if you use it) should establish **identity**; your portal/control Worker applies **tiers** and only then mints.

1. User signs in (Access + your IdP — can be a wide multitenant door).
2. Your Worker loads grants: operator vs assigned-device-only (or refuse). If exactly one device is linked, skip a device path and mint for that device.
3. On allow: `POST /sessions` with the mint secret → open `joins.browser` → agent joins with `agentToken`.

This hop only checks mint secret + join tokens. See [architecture.md](architecture.md#host-authorization-tiers).

### Screen acknowledgement extension

Resize commands may include an optional `id` (1–64 characters) and `mode` (`auto` or `manual`). The hop preserves these fields; older commands remain valid. Endpoint validation determines supported dimensions and whether a change can be applied.

An agent may send `t:stats` with only a `screen` acknowledgement. The viewer forwards it as `statsUpdate.screen` independently of CPU/memory telemetry; such an acknowledgement neither deletes those measurements nor refreshes their expiry. Missing screen state is unknown. Consumers must correlate `request_id` with their latest request and distinguish requested, effective desktop, and encoded frame geometry. A successful command write is not an applied resolution.

### Clipboard write confirmation

A text write with `id` receives a kind0x01 UTF-8 JSON frame `{t:"clipboard_result",id,status:"applied"|"rejected",reason:null|"invalid_text"|"clipboard_unavailable"}`. Applied means the native clipboard set succeeded. The viewer correlates only the latest outstanding write, expires it after15seconds, and reports disconnect/rejection through existing notifications. Invalid, stale or duplicate replies do not indicate success. Agent stats may advertise `clipboard_text_supported` and `clipboard_max_chars`. PC-to-browser changes continue using `{t:"clipboard",text}`. Do not export the initial OS clipboard or echo the browser’s own write as a PC change. Images remain a separate capability.

### Planned H.264 frame contract (not enabled)

Each future AVC frame payload is one complete Annex B access unit. Three- and four-byte start codes are recognized; NAL type uses the low five header bits. A key chunk includes an IDR picture plus SPS and PPS; a delta chunk includes non-IDR VCL. Parameter-set-only or truncated inputs are not independently decodable frame chunks. See the [W3C AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/). Native profile/configuration, decoding and JPEG fallback still require integrated verification before H.264 becomes the preferred default.
