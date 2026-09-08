/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Top-window microphone capture for the Jolee hop.
 * Runs in the dashboard (user-gesture window), posts base64 MediaRecorder
 * chunks to the hop core iframe as {type:"micChunk", mime, data}.
 * Original Jolee glue; not copied from Selkies.
 */

import { postToCore } from "./jolee-bridge.js";

let micStream = null;
let micRecorder = null;
let micGen = 0;
let micDeviceId = "";

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function createMicrophoneRecorder(stream) {
  if (typeof MediaRecorder === "undefined") {
    const err = new Error("MediaRecorder unavailable");
    err.name = "NotSupportedError";
    throw err;
  }
  const preferred = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  let lastErr = null;
  for (const mime of preferred) {
    if (typeof MediaRecorder.isTypeSupported === "function" && !MediaRecorder.isTypeSupported(mime)) {
      continue;
    }
    try {
      return new MediaRecorder(stream, { mimeType: mime });
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    return new MediaRecorder(stream);
  } catch (e) {
    throw lastErr || e;
  }
}

function clearMicrophoneResources() {
  micGen += 1;
  const rec = micRecorder;
  micRecorder = null;
  if (rec && rec.state !== "inactive") {
    try {
      rec.stop();
    } catch (e) {
      /* ignore */
    }
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
  }
  micStream = null;
}

export function stopParentMicrophone() {
  clearMicrophoneResources();
}

export function setParentMicDeviceId(deviceId) {
  micDeviceId = typeof deviceId === "string" ? deviceId : "";
}

export function isParentMicrophoneActive() {
  return !!(micRecorder && micRecorder.state === "recording");
}

/**
 * Start top-window mic capture. Resolves true on success, false on failure.
 * Posts micChunk messages while recording. Does not post pipelineControl.
 */
export async function startParentMicrophone() {
  if (micRecorder && micRecorder.state === "recording") return true;
  if (micRecorder || micStream) clearMicrophoneResources();
  const gen = (micGen += 1);
  // Each pending permission request owns its result until it is still current.
  // A stale completion must never replace the stream used by a newer recorder.
  let requestedStream = null;
  try {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") {
      throw new Error("getUserMedia unavailable");
    }
    let audioConstraints = true;
    if (micDeviceId && micDeviceId !== "default") {
      audioConstraints = { deviceId: { ideal: micDeviceId } };
    }
    try {
      requestedStream = await md.getUserMedia({ audio: audioConstraints });
    } catch (constraintErr) {
      if (gen !== micGen) return false;
      const n = constraintErr && constraintErr.name;
      if (
        audioConstraints !== true &&
        (n === "OverconstrainedError" || n === "NotFoundError" || n === "NotReadableError")
      ) {
        requestedStream = await md.getUserMedia({ audio: true });
      } else {
        throw constraintErr;
      }
    }
    if (gen !== micGen) {
      console.warn("Dashboard: microphone start aborted after getUserMedia (superseded)");
      requestedStream.getTracks().forEach((track) => track.stop());
      return false;
    }
    micStream = requestedStream;
    let recorder = null;
    let startErr = null;
    try {
      recorder = createMicrophoneRecorder(micStream);
      recorder.start(250);
    } catch (e) {
      startErr = e;
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch (ignore) {
        /* ignore */
      }
      try {
        recorder = new MediaRecorder(micStream);
        recorder.start(250);
        startErr = null;
      } catch (e2) {
        startErr = e2;
        recorder = null;
      }
    }
    if (startErr || !recorder) throw startErr || new Error("MediaRecorder start failed");
    if (gen !== micGen) {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch (e) {
        /* ignore */
      }
      requestedStream.getTracks().forEach((track) => track.stop());
      if (micStream === requestedStream) micStream = null;
      return false;
    }
    micRecorder = recorder;
    recorder.addEventListener("dataavailable", async (event) => {
      if (gen !== micGen || !event.data || !event.data.size) return;
      try {
        const data = bytesToBase64(new Uint8Array(await event.data.arrayBuffer()));
        if (gen !== micGen) return;
        postToCore(
          {
            type: "micChunk",
            mime: event.data.type || recorder.mimeType || "audio/webm",
            data,
          },
          window.location.origin
        );
      } catch (chunkErr) {
        console.warn(
          "Dashboard: microphone chunk failed",
          chunkErr && chunkErr.name,
          chunkErr && chunkErr.message
        );
      }
    });
    recorder.addEventListener("error", (event) => {
      if (gen !== micGen) return;
      const err = event && event.error;
      const name = (err && err.name) || "Error";
      const message = (err && err.message) || "MediaRecorder error";
      console.error("Dashboard: microphone recorder error", name, message);
      try {
        window.postMessage(
          {
            type: "pipelineStatusUpdate",
            microphone: false,
            error: name + ": " + message,
          },
          window.location.origin
        );
      } catch (postErr) {
        /* ignore */
      }
      clearMicrophoneResources();
    });
    recorder.addEventListener(
      "stop",
      () => {
        if (gen !== micGen) return;
        if (micRecorder !== recorder) return;
        micRecorder = null;
        if (micStream) {
          micStream.getTracks().forEach((track) => track.stop());
          micStream = null;
        }
      },
      { once: true }
    );
    return true;
  } catch (e) {
    if (gen !== micGen) {
      console.warn(
        "Dashboard: microphone start aborted (superseded)",
        e && e.name,
        e && e.message
      );
      return false;
    }
    const name = (e && e.name) || "Error";
    const message = (e && e.message) || String(e);
    console.error("Dashboard: microphone start failed", name, message);
    try {
      window.postMessage(
        {
          type: "pipelineStatusUpdate",
          microphone: false,
          error: name + ": " + message,
        },
        window.location.origin
      );
    } catch (postErr) {
      /* ignore */
    }
    clearMicrophoneResources();
    return false;
  }
}
