# Windows display controls

The Windows agent supplies `stats.screen.catalog`; the viewer must not infer supported resolutions from a generic preset list or video frame dimensions.

The catalog contains `revision`, nullable `selected_display_id`, and `displays`. Each display includes opaque `id`, `label`, `primary`, virtual-desktop `x`/`y`, current `width`/`height`, `current_mode_id`, `can_resize`, `reason`, and `modes`. Each mode contains opaque `id`, `width`, `height`, `refresh_hz`, `selectable`, and `reason`. IDs and revisions are 32 hexadecimal characters. Native Windows catalog limits are 16 displays, 512 modes per display, dimensions up to 65535, and refresh values up to 10000. Product capture limits are separate: a Windows mode may be displayed but disabled with `capture_limit`.

A removed selected monitor produces a null selected ID while remaining monitors stay selectable. No automatic retargeting of capture or input is allowed. Switching monitor changes capture/input selection, not Windows primary-monitor placement. Temporary resolution changes must be restored by the native guardian.

Browser commands echo the catalog revision and exact advertised IDs:

```json
{"t":"display_select","display_id":"...","catalog_revision":"...","request_id":"..."}
{"t":"resize","display_id":"...","catalog_revision":"...","request_id":"...","mode":"manual","mode_id":"...","w":1920,"h":1080}
{"t":"resize","display_id":"...","catalog_revision":"...","request_id":"...","mode":"best_fit","w":1365,"h":767}
```

Manual dimensions must match an advertised selectable mode. The browser does not round those dimensions. Resolution duplicates prefer a selectable mode near the current refresh rate. Presets identify the confirmed current dimensions, not an optimistic requested value.

Set to Best Fit is a one-shot request. Windows chooses the largest eligible mode fitting both viewport bounds; ties prefer the closest aspect ratio, current refresh, then stable ID. If none fits, choose the smallest maximum overflow ratio, then the same tie-breakers. The viewport uses CSS pixels unless the user enables HiDPI. This action does not reset local scaling, UI scaling, or cursor preferences, and does not repeatedly change the monitor on browser resize.

Screen acknowledgements retain `request_id`, `status`, `reason`, and `effective`, with selected ID/revision and refreshed catalog. A stale request fails with `catalog_changed`. The viewer requires fresh telemetry, waits for the matching native acknowledgement, and reports timeout/disconnection. Controls are unavailable when an older agent supplies no catalog.

## Verification

Automated checks cover strict catalog validation, disabled modes, duplicate resolution preference, negative monitor origins, removed monitor representation, exact request identities, stale revisions, and the built Edge controls. Native capture, mouse effects, mode application/restoration and multi-monitor behavior require integrated pilot verification before declaring this feature complete.
