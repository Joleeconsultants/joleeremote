This product extracts Selkies visual and functional experience onto the Jolee hop. Leftover panels still wait for a hop.

**Standing UI rule (Lee):** Before changing Selkies dashboard/chrome UI for a broken control, first read stock Selkies at the `UPSTREAM` pin and see what hop (`viewer.html` / core / `postMessage`) change is needed so their existing code works. Prefer hop glue that matches their behavior. Only patch their UI as a last resort when the hop cannot provide what stock expects.

# Selkies dashboard patches

## Goal

This product extracts Selkies visual and functional experience onto the Jolee hop. Leftover panels still wait for a hop.

Add a real hop path, then show the ORIGINAL Selkies dashboard control. Use original UI with only small mods (postToCore, overlay hide-flags in jolee-settings.js, PC Clipboard label). Do not invent a new UI. Do not write large Sidebar rewrites. Gaming stays out unless asked. Slow-add: a panel appears only after its hop exists.

Leftover list = recommended features not yet hopped, not a junk drawer. CSS cursors is original dashboard UI; the remote cursor overlay is hop core.

The current series starts with a refreshed integration baseline, then accepts small incremental patches. It is applied by `scripts/sync-selkies-dashboard.sh` after copying upstream `addons/selkies-dashboard`. `0010-trackpad-portrait-default.patch` shows the Trackpad tile in portrait only and defaults it on for touch clients.

The series rewires Selkies chrome onto the hop canvas. Add chrome back as the hop grows. Prefer overlay `chrome/selkies-dashboard/src/jolee-settings.js` for hide-flags so Sidebar diffs stay small.

## Visible now (hop exists)

- Screen (scale, AA, CSS cursors toggle, remote cursor overlay, HiDPI, force aligned, UI scaling, resolution)
- PC Clipboard (closed until opened; original Selkies default), text + image (`enable_binary_clipboard` unlocked)
- Audio playback (envelope kind `0x03` agent → browser)
- Microphone capture (`{t:"mic", mime, data}` browser → agent)
- Files (`{t:"file", name, mime, data}` in either direction)
- Webcam JPEG stills (`{t:"webcam", mime, data}` browser → agent)
- Sidebar stats (measured hop FPS/bandwidth plus optional agent stats JSON)
- Shortcuts and agent-owned encoder / quality settings
- Fullscreen and theme
- Mobile/touch keyboard FAB (original Selkies; not in the sidebar)

Image clipboard stays on input JSON / JSON frame. Cursor shape is the same JSON-frame pattern (`{t:"cursor",...}`), not a new envelope kind. Audio is envelope kind `0x03` because it is a byte stream like frames. Do not claim the hop has a Selkies pixelflux encoder. CSS cursors toggle is original UI; overlay follows the local pointer in the hop core.

## Leftover (recommended features not yet hopped)

- Apps
- Sharing
- Gaming (out unless asked)

## Overlay vs patches

- Overlay files listed in `chrome/selkies-dashboard/OVERLAY` are never overwritten by sync (`jolee-settings.js`, `jolee-bridge.js`, `jolee-shims/`, `jolee-theme.css`, …). Put hop-only hide-flags, brand CSS, and postMessage glue there.
- Patches in this directory are rewires of vendored Selkies files (`Sidebar.jsx`, translations, …). Keep them small.

### Brand + gutter (`jolee-theme.css`)

- **JO blues** — company brand (not Selkies pink/violet).
- **Always-on gutter** — `width: calc(280px + 8px)` + `scrollbar-gutter: stable` so **Jolee Remote** keeps title room and section toggles do not squeeze layout.
- **Easy undo** — drop only that `.sidebar` gutter block if it bugs; keep blue tokens. Rebuild dashboard. No Sidebar patch to unwind.
- Full note: [docs/chrome.md](../../../docs/chrome.md#brand-and-sidebar-gutter-overlay).

## Historical series (available in Git history)

| patch | why |
| --- | --- |
| `0001-sidebar-jolee-rewire.patch` | postToCore instead of same-window selkies-core; hop comments |
| `0002-player-gamepad-jolee-rewire.patch` | gamepad player shims (gamepads stay hidden) |
| `0003-dashboard-overlay-hop-controls.patch` | overlay hop controls |
| `0005-main-jsx-hop-entry.patch` | hop entry; no selkies-core |
| `0006-gitignore-keep-package-lock.patch` | keep package-lock |
| `0008-hide-sharing-until-enabled.patch` | seed hop settings; sharing/gamepads only if explicitly enabled |
| `0009-clipboard-open-pc-label.patch` | “PC Clipboard” copy only (panel stays closed by default) |
| `0010-shortcuts-command.patch` | make Shortcuts send Ctrl+Alt+Del; remove out-of-scope gaming rows |
| `0011-core-toggle-optimistic.patch` | optimistic active state for screen/speaker/mic/webcam toggles |
| `0012-jolee-theme-import.patch` | load Jolee blue brand tokens after Overlay.css |
| `0013-mic-parent-capture.patch` | parent-window mic capture + micChunk forward |
| `0014-mic-start-failure-ux.patch` | surface mic start failures via stock notification + start re-entry guard |

See also `docs/chrome.md`.
`0015-screen-setting-delivery.patch`: seed capture settings, persist FPS/quality, and coalesce rapid edits by key without changing controls.
`0016-indicator-readings.patch`: distinguish unavailable telemetry from measured zero; keep FPS text readable.
`0017-local-display-preferences.patch`: apply and persist existing local scaling and anti-aliasing choices.

`0027-image-clipboard-delivery.patch`: wire bounded inbound clipboard delivery and existing result notifications, including explicit pending-Paste feedback. Hop-specific delivery queue lives in the preserved `src/jolee-clipboard-delivery.js` overlay. No panel layout changes.

`0030-sas-command-results.patch`: gate the existing shortcut on the active agent capability and show correlated outcomes using existing notifications. No new layout.

`0031-confirm-audio-output.patch`: keep the existing speaker dropdown on the applied output until the core confirms routing; source-check returned selections.

`0032-secure-desktop-feedback.patch`: report validated continuity failures and observed normal-stream return through existing notifications; no layout changes.

`0033-microphone-session-lifecycle.patch`: stop parent capture on lost sessions/capabilities and correlate asynchronous starts. The preserved microphone session module owns intent; no layout changes.

## Reproducibility baseline (2026-09-09)

The previous series omitted patches 0027–0033 and failed at 0014 because an
unrecorded Files integration changed its context. It also failed at the first
patch on Windows when autocrlf converted patch context to CRLF.

0001-dashboard-integration.patch consolidates the existing tracked dashboard
differences from pinned Selkies 56618f4f54a4092c9bc07990f86d9682a33b1dfc.
It changes no deployed dashboard source or UI. Historical incremental patches
remain available in Git history; future changes should append small patches to
series. Git attributes preserve LF patch/series bytes on Windows.

After refreshing a patch, verify the pinned reconstruction before deployment:

```sh
bash scripts/sync-selkies-dashboard.sh
git diff --exit-code -- chrome/selkies-dashboard
```

This verifies reconstruction of the checked-in source, not live functionality.
## DPI delivery capability

Patch 0002 preserves the original UI and derived/default selection behavior from
the pinned Sidebar, while requiring confirmed native DPI support for startup,
reset and explicit writes. Unlike the original backend, the current Windows
agent does not implement DPI changes. A disabled dropdown must not leave hidden
startup/reset writes active. Locked settings also retain their server value.

Capability arrival initializes only DPI; debounce-time rechecking drops newly
unsupported/locked DPI without dropping other coalesced controls. Reset keeps
stored DPI untouched when unsupported. These checks do not implement native DPI
or establish live scaling acceptance. Local canvas scaling remains separate.

`0009-resolution-fields-encoder-filter.patch`: synchronize idle manual size fields with confirmed PC geometry, preserve unfinished edits, and populate the encoder control from fresh PC/browser capabilities. Loading/unavailable states disable the existing control; disconnect clears capabilities.

`0012-preserve-current-screen-controls.patch`: retain the reviewed Windows display behavior added after the previous baseline refresh. UI Scaling stays hidden until the agent advertises a writable choice, and unavailable resolution changes keep their existing status message. This patch also prevents upstream display-scoped DPI state from bypassing those capability checks.

## Automatic upstream updates

The scheduled Selkies workflow now attempts a real sync, reapplies the patch series, builds the dashboard and runs its checks before publishing a single update PR. The bot does not auto-merge upstream UI changes. If patches or validation fail, the existing tracking issue is updated with the latest revision and failing run instead of being left stale. Once main catches up, the issue closes automatically. Private sync/deployment follows the reviewed public merge.

Sync manifests support LF and CRLF checkouts. Latest upstream currently conflicts with the integration baseline's Sidebar imports; that requires a patch refresh, not dropping the overlays or forcing a failed build through.

## Upstream refresh (2026-09-10)

The baseline now targets7a45099a7420bfb676d7da948cb488ccc7f5b474. Previous0002-0009 patches are incorporated into0001, preserving their current deployed behavior; Git history retains the incremental originals. The live Sidebar change adopts upstream's Files loading indicator while preserving our absolute authenticated Files URL. Upstream CSS/translations merge cleanly.

The ten Sidebar conflicts overlap Windows display mode acknowledgement, actual encoder capabilities, microphone/camera state and the transport adapter. Preserve these Windows paths; upstream arbitrary Linux resolution/DPI derivation and new gaming pointer controls do not have equivalent supported Windows hops. This refresh does not enable them or replace the advertised Windows mode catalog. Verify the final vendored diff as well as patch reconstruction; a large baseline diff is not a request to redesign the UI.
