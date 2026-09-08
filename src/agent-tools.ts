/**
 * Protocol tools for a device agent. Capture/inject are OS-side; this module
 * is wire format only. Import (or copy) these helpers to speak the hop
 * envelope + viewer JSON shapes. See docs/consumer-tools.md.
 */

export {
  ENVELOPE_VERSION,
  KIND_FRAME,
  KIND_INPUT,
  KIND_AUDIO,
  MAX_ENVELOPE_BYTES,
  encodeEnvelope,
  decodeEnvelope,
  envelopeByteLength,
  type Envelope,
  type EnvelopeKind,
} from "./envelope";

export {
  agentJoinPath,
  browserJoinPath,
  partyBrowserPath,
  viewerPath,
  viewerQuery,
  viewerHash,
} from "./joins";

export {
  parseInputPayload,
  parseInputJson,
  normalizeCommand,
  type InputPayload,
  type PointerInput,
  type WheelInput,
  type KeyInput,
  type ClipboardInput,
  type ClipboardTextInput,
  type ClipboardImageInput,
  type ClipboardPasteInput,
  type ResizeInput,
  type CssScalingInput,
  type SettingsInput,
  type AudioDeviceInput,
  type PipelineInput,
  type MicInput,
  type WebcamInput,
  type FileInput,
  type CommandInput,
  type PingInput,
} from "./input";

export {
  encodeJsonFrame,
  encodeClipboardTextFrame,
  encodeClipboardImageFrame,
  encodeCursorFrame,
  encodeFileFrame,
  encodeStatsFrame,
  encodePrintFrames,
  maxPrintRawSlice,
  PRINT_SAFE_RAW_SLICE,
  type CursorFrameOpts,
  type PrintFrameOpts,
} from "./agent-frames";

export {
  encodeFilesListRequest,
  encodeFilesGetRequest,
  filesListFromFrame,
  filesGetFromFrame,
  isSafeFilesPath,
  type FilesListEntry,
  type FilesListFrame,
  type FilesGetFrame,
  parseJsonFrameObject,
  clipboardTextFromFrame,
  cursorFromFrame,
  fileFromFrame,
  statsFromFrame,
  printFromFrame,
  type ClipboardFrame,
  type CursorFrame,
  type FileFrame,
  type PrintFrame,
} from "./json-frame";
