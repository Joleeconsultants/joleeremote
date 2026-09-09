# Session-scoped print redirect

**Status:** **viewer side shipped** in this repo (`public/viewer.html` + `printFromFrame` in `src/json-frame.ts`). The **session-only virtual printer** remains **consumer agent** work. This hop does not install drivers, speak RDPDR on the wire, or vendor IronRDP.

## What already works here

Agent → hop → browser may send a finished document as a kind `0x01` JSON frame. The viewer opens the **browser print dialog** (Google Docs–like). Silent OS spool is not available from Chrome.

## Tool map

Full consumer map (capture, input, clipboard, print, …): [consumer-tools.md](consumer-tools.md).

## Consumer how-to (Windows session printer → hop PDF)

Build this in the **consumer agent**, not in this hop repo.

1. On hop **paired**: add a **session-only** print queue on the device OS (appear only while remoted in).
2. Apps print to that queue. Buffer the job with the same lifecycle as RDP printer redirect: **Create → Write (many) → Close**.
3. Prefer a PostScript-capable server-side driver when the host has one (IronRDP/FreeRDP default name: `MS Publisher Imagesetter`). Convert **PostScript → PDF** before the hop (e.g. Ghostscript). Chrome prints PDF well; raw PostScript does not.
4. Send `{t:"print", mime:"application/pdf", name, data}` on a frame (chunk with `job` / `part` / `parts` if over the 1 MiB envelope).
5. On disconnect / TTL / teardown: **remove** the queue so it is gone when nobody is in session.

Do not leave a permanent product printer installed between sessions.

### Cite: IronRDP (job lifecycle reference)

Use [IronRDP](https://github.com/Devolutions/IronRDP) / crate [`ironrdp-rdpdr`](https://crates.io/crates/ironrdp-rdpdr) as the open-source reference for printer redirection semantics — not as something this hop embeds.

| Piece | Where |
| --- | --- |
| Repo | https://github.com/Devolutions/IronRDP (MIT OR Apache-2.0) |
| Crate | https://crates.io/crates/ironrdp-rdpdr |
| API | `Rdpdr::with_printer` / `with_printer_driver`, `RdpdrBackend::handle_printer_io_request` |
| Docs | https://docs.rs/ironrdp-rdpdr |
| Spec backdrop | [MS-RDPEFS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/34d9de58-b2b5-40b6-b970-f82d4603bdb5) |

IronRDP’s model (from their RDPDR README):

- `with_printer` announces a PostScript virtual printer using `MS Publisher Imagesetter` by default (same default FreeRDP uses for CUPS PostScript redirect).
- Printer IRPs deliver raw job bytes to the backend: Create / Write / Close.
- Printers are advertised after the server’s user-logged-on signal in RDPDR; steal that **session-scoped** idea for hop pair/teardown.
- The client stays format-agnostic until you convert (PostScript → PDF) before presenting the job.

**Important:** `ironrdp-rdpdr` is an RDP **client** channel. It fits if your consumer is already an RDP client. A hop agent that sits on the Windows PC and speaks this Worker’s WebSocket still needs a **Windows session print queue** (or equivalent) on the OS; then apply the same Create/Write/Close → convert → hop PDF path. Prefer depending on IronRDP in that consumer when you are an RDP client so updates come from crates.io — do not copy their sources into this repo.

### Other pieces the consumer needs

- Mint / join already from this hop (`POST /sessions`, `joins.browser`, `joins.agent`) — see [agent.md](agent.md).
- Enable the session printer only after **paired**; remove on teardown.
- Convert before send; prefer `application/pdf`.
- Respect `MAX_ENVELOPE_BYTES` (1 MiB) with chunking.
- Expect the **browser print dialog** in the web viewer (not silent spool).

## Hop vs consumer

| Layer | Owns |
| --- | --- |
| Consumer agent | Session-only printer, Create/Write/Close buffer, PostScript→PDF, send print frames |
| Hop | Opaque forward (mint/pair/TTL); does not parse print JSON |
| Viewer | Reassemble chunks; `iframe` + `contentWindow.print()` |

## Shipped viewer contract

Keep `public/viewer.html` in sync with `src/json-frame.ts` (`PrintFrame` / `printFromFrame`).

### Single-shot

```json
{ "t": "print", "mime": "application/pdf", "name": "document.pdf", "data": "<base64>" }
```

### Chunking

```json
{ "t": "print", "job": "<id>", "part": 0, "parts": 3, "mime": "application/pdf", "name": "document.pdf", "data": "<base64 of byte slice>" }
```

Viewer decodes each slice to bytes, concatenates in order, then opens print preview. The receiver admits at most 86 parts, 16 MiB per assembled job and four incomplete jobs. Incomplete jobs expire after 120 seconds and clear when pairing is lost. Conflicting duplicate chunks or metadata discard the job; only completed documents emit the parent print notification.

The Windows 0.5.104 producer's `pdf_folder` mode is an intermediate transport implementation: Microsoft Print to PDF must save into the current session's designated random folder. It is not automatic virtual-printer redirection. The producer's 192 KiB raw chunks fit the 1 MiB envelope after base64 and bounded metadata. Folder discovery and an actual browser print-dialog check are required before accepting that workflow.

### Viewer behavior

1. PDF and `image/*` → browser print dialog.
2. Other mime → download (same as `{t:"file",…}`).
3. Optional parent hint: `postMessage({ type: "printJob", name, mime })`.

## Out of scope (this repo)

- Vendoring or depending on IronRDP in the Worker
- Windows printer drivers / port monitors / MSI packaging
- Permanent printers, silent web print, canvas screenshot print
- Apps / Sharing / Gaming chrome

## Related

- [agent.md](agent.md)
- [chrome.md](chrome.md)
