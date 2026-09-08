# Remote cursor delivery

Both existing cursor modes consume the same PC shape: overlay renders its PNG; CSS mode uses that PNG and hotspot as the browser cursor. A hidden update hides both. A new hotspot repositions a stationary overlay. Session loss clears the old shape. The sidebar layout and toggle remain unchanged.

Agent frame envelope kind1 carries JSON `{t:"cursor",visible:true,mime:"image/png",data:"<base64 PNG>",hx:0,hy:0}`. PNG is bounded to 128x128 and 128KiB, with integer hotspot inside its IHDR dimensions. Hidden updates use `{t:"cursor",visible:false}`. Legacy visibility-only messages retain the last shape. Malformed image metadata cannot replace the current cursor. Native delivery must bind capture to the active desktop/helper and send initial/changed shapes; refresh covers reconnect.

Native delivery is still under integration verification. Animated cursors currently provide a sampled static shape. PNG cannot express background-XOR inversion; native rendering approximates it. Oversized/custom cursors may be hidden by the bounded native sampler; those cases are not parity-complete.

Validation: browser tests cover PNG bounds/hotspots, CSS/overlay visibility, stationary hotspot changes and reset. Actual Edge viewer with a substituted transport consumed a generated I-beam PNG and used its 15,16 hotspot in CSS mode, then hid both renderers on a hidden frame. No live PC cursor acceptance is claimed by this browser change.
