# Dashboard chrome

Product session UI that maps Selkies visual and functional experience onto the Jolee hop. Panels without a hop path remain hidden until one exists.

`/` is the product session UI: modified Selkies dashboard chrome (MPL-2.0) over the hop.

`/viewer.html` is the canvas hole: PartySocket, byte envelope, canvas paint, remote cursor overlay, pointer/key/wheel input, and postMessage. No header, no Connect button, no status pill.

This repo ships modified Selkies dashboard chrome, not the Selkies streaming stack (no selkies-web-core).

Dashboard chrome is MPL-2.0 (see `chrome/selkies-dashboard/LICENSE`). The hop (`src/`, `public/viewer.html`, Worker, Durable Object) is MIT.

## Goal

**Standing UI rule (Lee):** Before changing Selkies dashboard/chrome UI for a broken control, first read stock Selkies at the `UPSTREAM` pin and see what hop (`viewer.html` / core / `postMessage`) change is needed so their existing code works. Prefer hop glue that matches their behavior. Only patch their UI as a last resort when the hop cannot provide what stock expects.


Extract Selkies visual and functional experience onto the Jolee hop. Leftover panels wait until a hop path exists.

Add a real hop path, then show the ORIGINAL Selkies dashboard control. Prefer original UI with only small mods (`postToCore`, overlay hide-flags in `jolee-settings.js`, PC Clipboard label). Do not invent a new UI or large Sidebar rewrites. Gaming stays out unless asked. Slow-add: a panel appears only after its hop exists.

The leftover list is recommended features not yet hopped, not a junk drawer. CSS cursors is original dashboard UI; the remote cursor overlay is hop core in `/viewer.html`.

Chrome keeps only controls the hop can drive. Restore chrome as the hop grows. Hide-flags live in overlay `jolee-settings.js`. The patch series documents that rule in [chrome/patches/selkies-dashboard/README.md](../chrome/patches/selkies-dashboard/README.md).

## Brand and sidebar gutter (overlay)

Keep UI diffs tiny and easy to undo. Brand and layout tweaks live in overlay [`chrome/selkies-dashboard/src/jolee-theme.css`](../chrome/selkies-dashboard/src/jolee-theme.css) (listed in `OVERLAY`; sync does not overwrite it). Loaded after Selkies `Overlay.css` via patch `0012-jolee-theme-import.patch`.

| What | Why |
| --- | --- |
| JO blue tokens | Company brand colors (replace Selkies pink/violet accents) |
| `.sidebar { width: calc(280px + 8px); scrollbar-gutter: stable; }` | Always-on gutter so the long title **Jolee Remote** keeps room and opening/closing sections does not squeeze content |

Do **not** add dynamic gutter JS or large Sidebar rewrites for this. Prefer stock Selkies chrome with these small CSS mods.

**Undo if buggy:** delete only the `.sidebar { … scrollbar-gutter … }` block in `jolee-theme.css` (keep the blue tokens if you still want brand). Rebuild the dashboard (`npm run build:dashboard`). No Sidebar patch to reverse.

## Join

**Tab titles (noVNC-style):** the shell sets `document.title` to `Jolee Remote - {device}` when `?device=` is present (else `Jolee Remote`). This is hop/shell glue, not Selkies static title or Sidebar patches.

The one browser join URL opens Selkies chrome:

```
https://remote.example.com/?session=<id>#token=<browserToken>
```

If the Worker is a different host:

```
https://remote.example.com/?session=<id>&hop=<worker-host>#token=<browserToken>
```

| param | meaning |
| --- | --- |
| `session` | session id from `POST /sessions` |
| `token` | browser join token (prefer `#token=` fragment; `?token=` is fallback) |
| `hop` | Worker host; default this origin. HTML can live on any host you control (docs placeholder: `remote.example.com`) |
| `device` | optional display name for the browser tab (`Jolee Remote - {name}`); set by the host mint redirect (noVNC-style). Not a Selkies static/manifest title — shell/hop glue reads `?device=` in `public/index.html` and may strip it via `history.replaceState`. Do not put secrets here. |

`joins.browser` from mint is a path on the hop Worker (`viewerPath`): `/?session=<id>&hop=<worker-host>#token=<browserToken>`. If HTML is on `https://remote.example.com` and the Worker is elsewhere, prefix that origin and keep `hop`. `public/index.html` copies search params except `token` onto the iframe query, and puts the token on the iframe hash (hash first, then query fallback). The hop core auto-connects. A host app can also postMessage `connect` / `disconnect` to the iframe.

## Microphone (parent capture)

Enable Microphone runs `getUserMedia` + `MediaRecorder` in the top-window dashboard (`jolee-mic-capture.js`), then forwards `micChunk` into the hop core iframe. On start failure the overlay posts `pipelineStatusUpdate` with `microphone: false` and `error`, resets the stock Enable/Disable control, and reuses the existing Selkies error notification toast (no new UI).

## postMessage contract

Same-origin `window` messages from the parent shell to `iframe#jolee-core`.

**Handled** (the sidebar only shows controls that map here):

| type | payload | action |
| --- | --- | --- |
| `connect` | `{session, token, hop}` | PartySocket join as browser |
| `disconnect` | | close socket |
| `requestFullscreen` | | parent `#jolee-core` iframe `requestFullscreen` in the click tick (`jolee-bridge.js`); on failure the viewer `#stage` (canvas + cursor overlay) tries fullscreen |
| `setScaleLocally` | `{value: boolean}` | CSS object-fit contain vs stretch/fill |
| `setAntiAliasing` | `{value: boolean}` | `ctx.imageSmoothingEnabled` after every canvas size reset |
| `setUseBrowserCursors` | `{value: boolean}` | original CSS cursors toggle. `true`: overlay hidden, local `default` pointer. `false` (default): hide OS pointer, draw remote overlay |
| `touchinput:trackpad` | | enable relative mobile cursor, tap clicks, two-finger scroll/right click, and local pinch zoom/pan |
| `touchinput:touch` | | restore default absolute touch input and reset local zoom |
| `showVirtualKeyboard` | | focus canvas and hidden `#vk` |
| `assistKey` | `{e, key, code}` | input envelope `{t:key,...}` from parent `#keyboard-input-assist` |
| `clipboardUpdateFromUI` | `{text}` | input envelope `{t:clipboard, text}` if connected |
| `clipboardImageUpdate` | `{imageBlob}` | Blob/File from the sidebar; viewer base64-encodes and sends `{t:clipboard, mime, data}` if the envelope is ≤ 1 MiB |
| `fileUpload` | `{file}` | base64-encode a parent-picked File and send `{t:"file", name, mime, data}` if the envelope is ≤ 1 MiB |
| `pipelineControl` | `{pipeline, enabled}` | `video`: gate canvas paint + status; `audio`: mute/stop playback + status; `webcam`: capture start/stop (`{t:webcam}`). `microphone`: parent dashboard owns capture; viewer only arms forwarding + input `{t:pipeline, pipeline, enabled}`. HTML shells advertise `Permissions-Policy: microphone=*, camera=*, fullscreen=*` and the core iframe allows `microphone *` / `camera *`. |
| `micChunk` | `{mime, data}` | Parent MediaRecorder chunk (base64). Viewer forwards `{t:"mic", mime, data}` on the hop WS when microphone forwarding is armed. |
| `audioDeviceSelected` | `{context, deviceId}` | input applied to next/live mic `getUserMedia`; output uses `setSinkId` if present; also `sendInput({t:"audioDevice", context, deviceId})` |
| `setManualResolution` | `{width, height}` | `sendInput({t:"resize", w, h})` |
| `resetResolutionToWindow` | | `sendInput({t:"resize", w:round(innerWidth), h:round(innerHeight), reset:true})` |
| `setUseCssScaling` | `{value: boolean}` | `sendInput({t:"cssScaling", value})` |
| `settings` | `{settings}` | if present, `sendInput({t:"settings", settings})` covering `scaling_dpi` and `force_aligned_resolution` |
| `command` | command payload | input `{t:"command", ...}`; Ctrl+Alt+Del spellings normalize to `command:"ctrl-alt-delete"` |
| `getStats` | | immediately publish the current hop/agent stats snapshot |

Core to parent (only when window.parent is not window):

| type | payload |
| --- | --- |
| `trackpadModeUpdate` | `{enabled: boolean}` — active touch mode for the stock sidebar |
| `status` | `{state: waiting | paired | expired | disconnected}` |
| `clipboardContentUpdate` | `{text}` — viewer saw a frame whose payload is UTF-8 JSON `{"t":"clipboard","text":"..."}`. Hop does not parse it. |
| `clipboardImageUpdate` | `{mime, data}` — viewer saw a JSON clipboard frame with `mime` starting `image/` and base64 `data`. Sidebar may ignore this. |
| `pipelineStatusUpdate` | microphone/webcam active state after permission and capture start/stop |
| `statsUpdate` | dashboard globals for CPU, memory, GPU, FPS, bandwidth, latency, and audio level |
| `printJob` | `{name, mime}` — optional chrome awareness when a print JSON frame arrives (no blob URL). Parent may ignore. |

## Files (locked Option A)

**Download Files** / file UX lists and gets files via hop `filesList` / `filesGet` toward the paired agent: requests in kind `0x02`, responses in kind `0x01`. UI and `letleeadmin` CLI target the same PC `FileManagerPath` / Desktop folder via the Worker asking that agent. The consumer owns PC path resolution; the hop stays opaque. A Session DO inbox, if used by a consumer, is interim only.

The existing `fileUpload` → `{t:"file",name,mime,data}` postMessage mapping above stays the upload path. Agent → browser `{t:"file",name,mime,data}` frames remain the canary/push download path, distinct from `filesGet`. All use the 1 MiB whole-envelope cap. See [agent.md — Files](agent.md#files-locked-option-a) for the locked shapes. The Worker now serves `/api/files/` using stock `chrome/selkies-files/header.html` + `table#list` + `footer.html`. Folder links end in `/`, file links download, and the heading shows `/api/files/` plus the current relative directory. The stock footer hides `../` at root. Its injected path prefix preserves the public mount in the heading; the vendored shell is unchanged.

Open `/api/files/?session=SESSION&token=TOKEN`; subsequent navigation uses session cookies. Bearer tokens are also supported. Add `format=json` for `{sessionId,source:"pc",path,files}`. Nested URLs list via `askAgentFilesList(path)` or download via `askAgentFilesGet(relativeId)`. The route reads the paired PC, never the Session inbox, and does not add portal Access/service logic or new postMessage types. Subfolders require agent 0.5.89+; uploads retain the existing envelope path.

## What's left

**Visible now:** screen and agent-owned encoder preference (default H.264; JPEG fallback) + frame-rate/JPEG-quality settings, PC clipboard text+image, audio playback, microphone capture, file upload/download, webcam JPEG stills, stats gauges, a Ctrl+Alt+Del shortcut, fullscreen, theme, mobile keyboard, and Trackpad Mode. Session print frames open the browser print dialog / preview in the hop viewer (PDF preferred); silent OS spool stays desktop-client only. Paint-over and the other Selkies-only encoder controls stay hidden. Overlay is hop core; CSS cursors is original UI. There is no pixelflux.

**Hidden until that hop exists** (leftover list):

- Apps
- Sharing
- Gaming (out unless asked)

Trackpad is in scope and visible; Trackpad ≠ Gaming. One-finger movement controls a relative cursor (1.25× sensitivity); a short tap clicks at that cursor. Two-finger drag scrolls, two-finger tap or a stationary 500 ms one-finger hold right-clicks. Pinch zooms/pans the local canvas (1–4×) without remote input; each two-finger gesture locks to scrolling or pinching after a 10 px threshold. Switching back to touch restores absolute positioning and resets zoom.

On touch clients, Trackpad Mode defaults **on in portrait**. Landscape **hides** the sidebar Trackpad tile and forces absolute touch. The last portrait choice is session memory only (no `localStorage`) and is restored when rotating back to portrait (default on). The core posts `trackpadModeUpdate` so the tile stays in sync.

Drawn text caret: `EXPERIMENTAL_IBEAM_CONTRAST` in `public/viewer.html` replaces the remoted I-beam bitmap with a high-contrast SVG. Set the flag to `false` (or delete that block and the `applyCursorFrame` branch) to revert.

Gaming (gamepads, gaming mode, soft buttons, extra player seats) stays hidden. Image clipboard is unlocked: it is a hop JSON path, not a Selkies pixelflux encoder. A leftover postMessage of still-hidden types is ignored so a stale build cannot crash the core.

```mermaid
flowchart LR
  Dashboard[Dashboard chrome] -->|postMessage| Core[iframe hop core]
  Core -->|PartySocket| Worker[Worker]
  Worker --> DO[Session Durable Object]
  Agent[Outbound agent] -->|WebSocket client| DO
```

## Keeping chrome in sync

### Goal

Extract Selkies visual and functional experience onto the Jolee hop. Leftover panels wait until a hop path exists.

Add a real hop path, then show the ORIGINAL Selkies dashboard control. Prefer original UI with only small mods (`postToCore`, overlay hide-flags in `jolee-settings.js`, PC Clipboard label). Do not invent a new UI or large Sidebar rewrites. Gaming stays out unless asked. Slow-add: a panel appears only after its hop exists.

The leftover list is recommended features not yet hopped, not a junk drawer.

This repo ships modified Selkies dashboard chrome, not the Selkies streaming stack (no selkies-web-core).

The patch series exists to rewire that chrome onto the hop canvas. Add chrome back as the hop grows; a panel appears only after its hop exists. Prefer overlay `src/jolee-settings.js` hide-flags so Sidebar diffs stay small. See [chrome/patches/selkies-dashboard/README.md](../chrome/patches/selkies-dashboard/README.md).

Do not bump packages past what the source uses: dashboard npm follows the pinned Selkies package.json; wrangler, workers-types, partyserver, and partysocket follow those sources, not latest-on-npm.

Dependabot covers npm weekly (Monday) at `/` and `/chrome/selkies-dashboard`, plus GitHub Actions at `/`. The dashboard is pinned in `chrome/selkies-dashboard/UPSTREAM`; overlay files in `OVERLAY` are kept; Jolee rewires are `chrome/patches/selkies-dashboard/` plus `scripts/sync-selkies-dashboard.sh` (`latest` or a SHA). A weekday Action opens an issue titled "Selkies dashboard upstream moved" when the pin is behind.

## Adding remote shortcuts

The Shortcuts panel uses the same `resolution-button` class as Files. Keep the
Files action spacing: 5px above and below each button, supplied by
`#shortcuts-content > .resolution-button` in the Jolee theme overlay. Reuse the
existing full-width buttons, colors, border, radius, typography, hover and focus
styles; do not stack touching buttons or introduce a separate button design.

For ordinary keys, follow Esc and F11 (Full Screen): the sidebar posts
`{type: "shortcutKey", key: "Escape"}` (or `F11`) to the core. `sendShortcutKey`
in `public/viewer.html` accepts an explicit allowlist, requires a paired session,
and sends one `key` down/up pair through the existing input path. It does not
queue presses for reconnect or release a key already held by this viewer.
F11 affects the remote application's fullscreen behavior, not the local browser.

To add another ordinary key, verify its native key mapping, extend the explicit
core allowlist, add the matching sidebar button and tooltip, and update the
key-packet and shipped-dashboard delivery checks. Preserve sidebar changes in
the pinned Selkies patch series and rebuild the dashboard assets. Publish the
public change first, then sync the private product and deploy.

Ctrl+Alt+Del is different: it uses the privileged SAS command and capability
checks. Do not route it as ordinary key presses or use ordinary shortcut buttons
to bypass native secure-desktop admission. A button being present or a packet
being sent does not prove Windows accepted it; remote acceptance depends on the
native input path and should be verified when that path is available.
