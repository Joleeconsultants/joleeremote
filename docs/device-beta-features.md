# Per-device beta features

`printingBeta` and `microphoneBeta` independently default to false. Only internal mint RPC accepts flags; public HTTP mint does not accept flag overrides. The private integration retrieves authoritative per-device flags from the controller before minting and snapshots them in the session Durable Object. Missing records (including preexisting sessions) default off. Flag changes apply to newly minted sessions, not already-running ones; renewals cannot widen flags.

The viewer accepts flags only in status messages from its current relay WebSocket. Disabled microphone forwarding hides the microphone controls, suppresses permission requests for input labels, and gates capture/forwarding. Disabled printing suppresses assembly, preview and printing diagnostics. Enabled features display Beta. Relay enforcement drops print frames and microphone input/pipeline/device/settings messages when disabled. PC audio and ordinary input/file transfers remain available.

This does not uninstall components or prevent native driver setup; native installation policy is separately enforced by the agent/controller. A generic PDF file transfer remains a file transfer, not an automatic print job. Flags are release controls, not a replacement for session authorization.
