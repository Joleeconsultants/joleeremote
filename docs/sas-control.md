# SAS browser wire contract v1

Fixed shared schema for main-owned browser integration. Build-owned agent implementation must match these types. Metadata and this contract do not enable production SAS; the action requires a valid available capability from the active agent session.

## Scalar rules and transport

Use the existing browser-input envelope for commands and existing agent-telemetry JSON frame for capabilities/results. JSON numbers `expires_at` are integer Unix milliseconds, never ISO strings, seconds, fractional values, NaN, or Infinity. Require Number.isSafeInteger and a future deadline for an available capability. The deadline must not exceed the active minted session expiry when that expiry is known; agent emits its exact immutable mint deadline.

`session_id` is the exact active minted session ID,1–200 characters. `generation` is exactly32 uppercase hexadecimal ASCII characters (`^[0-9A-F]{32}$`). Request `id` is a nonzero canonical UUID in lowercase D format. The browser uses crypto.randomUUID() once per explicit click. No principal, email, token, Windows SID, or policy value appears in these frames.

Reject unknown versions, extra/duplicate JSON keys where the receiving parser can detect duplicates, missing fields, incorrect types, or unsupported status/code/effect combinations. Never interpret malformed capability data as permission to enable the action. The agent request parser enforces duplicate-key rejection and a1KiB command payload limit. A browser JSON parser without duplicate-key visibility must still strictly validate the parsed object; these telemetry frames are agent-generated and not an authorization input to the agent.

## Agent capability

```ts
type SasAvailabilityReason =
  | 'unsupported' | 'unauthorized' | 'expired' | 'unpaired'
  | 'policy_denied' | 'policy_unreadable' | 'service_required'
  | 'session_unavailable' | 'session_changed'
  | 'audit_unavailable' | 'native_unavailable';

type SasCapabilityV1 = {
  t: 'control_capabilities';
  v: 1;
  session_id: string;
  generation: string;
  expires_at: number;
  sas: { available: true; reason: null }
     | { available: false; reason: SasAvailabilityReason };
};
```

The six outer fields are exact. The two sas fields are exact. Capabilities are a snapshot, not an execution guarantee; native authorization/policy/session checks happen again on every request. Missing capability means unsupported; retain the existing menu layout and disable this action. Do not infer support from version, private provenance, historical settings, or an old connection's capability.

A new pairing gets a fresh generation. A capability update may change availability within the same generation. Generation invalidation, unavailable capability, unpair, disconnect, or expiry disables the action immediately. If an action was pending, its outcome becomes locally unknown; do not claim native rejection solely because the connection or capability changed.

## Browser request

```ts
type SasCommandV1 = {
  t: 'command';
  v: 1;
  command: 'ctrl-alt-delete';
  id: string;
  generation: string;
};
```

Exactly five fields. Do not add client/device/Windows-session selection to this message. The existing connection and agent-owned session context supply the target. Send only after one explicit click, while paired with a valid unexpired available capability and no pending SAS command. Capture the session ID, connection instance, generation and ID locally for correlation. Start a5-second pending timer; temporarily disable repeated clicks. No keyboard injection, local OS shortcut, or fallback invocation.

## Agent result

```ts
type SasRejectCode =
  | SasAvailabilityReason
  | 'invalid_request' | 'stale_generation' | 'id_conflict'
  | 'rate_limited' | 'busy' | 'ledger_full' | 'cancelled'
  | 'preflight_unavailable';

type SasResultV1 = {
  t: 'command_result';
  v: 1;
  command: 'ctrl-alt-delete';
  session_id: string;
  generation: string;
  id: string;
} & (
  | { status: 'rejected'; code: SasRejectCode; effect: 'not_attempted' }
  | { status: 'invoked'; code: 'native_call_returned'; effect: 'unverified' }
  | { status: 'uncertain'; code: 'in_progress' | 'native_outcome_unknown' | 'audit_unavailable'; effect: 'unverified' }
);
```

Exactly nine fields. `session_id`, `generation` and `id` always reflect the original correlated request context, including cached duplicate outcomes. Native call return must never map to an applied, displayed, succeeded, or physically observed status. Rejected guarantees that the native call was not entered. Uncertain means the call may have run or may still be in progress; never retry automatically.

The browser accepts a result only if all of active connection instance, active session ID, pending request ID, and captured generation match. Unknown IDs, a result from a retired connection, or old session/generation results cannot resolve a new pending action. An exact old duplicate result remains harmless because the browser never carries pending state into a new generation.

## Existing notification behavior

- invoked/native_call_returned: show "Ctrl+Alt+Delete requested." Do not say the security screen is open.
- rejected: show "Ctrl+Alt+Delete was not sent." Optionally append a fixed friendly explanation for its validated code; never render arbitrary server text.
- uncertain: show "Ctrl+Alt+Delete outcome is unknown. Check the remote screen before trying again."
-5-second timeout, disconnect, generation change, or capability loss during a pending action: same local unknown-outcome wording. Do not synthesize an agent rejected result or resend. Clear the timer and pending record; a later unrelated/stale response cannot report success for another click.

A valid late result after the local pending record was cleared is ignored. A fresh explicit user click may create a new ID only if current capability/pairing are available; the agent's5-second device rate limit and session ledger remain authoritative. No background reconnect replay, persisted request queue, saved pending command, or auto-retry button action.

## Required fixtures

Prove exact field/type/version validation; malformed/unavailable/missing/expired capability disabled; normal click sends exactly one command with current generation; repeated clicks while pending send none; successful result shows requested, not displayed; every status/effect mismatch rejects; timeout and uncertain never resend; expired/disconnected/new-generation connection discards pending state; stale or wrong session/ID/connection results cannot complete a fresh request; browser reload does not restore pending commands. Keep native invocation mocked and do not send a live SAS during browser development.
