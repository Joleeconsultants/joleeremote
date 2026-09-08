# Secure desktop status v1

This browser telemetry observes a previously issued Ctrl+Alt+Delete request. It never authorizes an action, retries input, or exposes native helper identity/private context. Existing UI notifications are reused.

Exactly eight fields: `t: "secure_desktop_status"`, `v: 1`, `session_id`, `generation`, `id`, `sequence`, `status`, `code`. Session/generation/request formats match the SAS contract. Sequence is a safe integer 1 through 64, strictly increasing per request.

| Status | Allowed code | Evidence/meaning |
| --- | --- | --- |
| observing | helper_ready | Authenticated helper prepared; no pixel or input claim |
| active | secure_frame_received | First validated fresh Winlogon frame sent on the session transport; no successful-input claim |
| warning | input_rejected, input_partial, input_unknown | Checked input receipt; nonterminal |
| returned | normal_frame_received | Authenticated return to Default followed by fresh normal-helper frame sent; terminal, not an unlock or interaction-success claim |
| failed | prepare_failed, helper_lost, deadline_reached, session_changed, capture_unavailable, return_unobserved, cancelled | Terminal failure; no verified return claim |

The browser correlates a frame only to a locally issued request on the same live connection/session/original generation. Entries live at most45 seconds and never beyond the original mint expiry. The five-second command-result timeout and same-generation unavailable capability do not erase continuity observation. Replacement, malformed capability, generation change, or expiry retires it. At most128 entries are retained; UUID reuse within their lifetime is refused. No persistence or replay.

Observing and active are silent. Each warning code is reported once; terminal return/failure closes observation. Duplicate/decreasing sequence, unrelated requests, wrong connection/session/generation, extra fields, unrecognized or wrongly typed vocabulary, and post-terminal messages are discarded. Native senders must coalesce repeated warnings and preserve room for a terminal state within64 sequence slots. Probe-only readiness has no browser-issued request and produces no notification.

Validation: schema/correlation/deadline/bounded-store/order tests; actual local dashboard+viewer with substituted transport verifies one partial-input notification and one command, then normal-stream return with later contradictory failure ignored. No real SAS, PC input, or helper was used. Native integrated verification remains separate.
