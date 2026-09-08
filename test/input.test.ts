import { describe, expect, it } from "vitest";
import {
  normalizeCommand,
  parseInputJson,
  parseInputPayload,
} from "../src/input";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("parseInputPayload / parseInputJson", () => {
  it("preserves clipboard correlation ids and rejects malformed ids", () => {
    expect(parseInputJson(JSON.stringify({t:'clipboard',text:'hello',id:'write-1'}))).toEqual({t:'clipboard',text:'hello',id:'write-1'});
    for (const id of ['', 'x'.repeat(65), 3, null]) expect(parseInputJson(JSON.stringify({t:'clipboard',text:'hello',id}))).toBeNull();
  });
  it("parses pointer move/down/up", () => {
    expect(parseInputJson('{"t":"pointer","e":"move","x":0.5,"y":0.25,"b":1}')).toEqual({
      t: "pointer",
      e: "move",
      x: 0.5,
      y: 0.25,
      b: 1,
    });
    expect(parseInputJson('{"t":"pointer","e":"down","x":0,"y":1,"b":0}')).toEqual({
      t: "pointer",
      e: "down",
      x: 0,
      y: 1,
      b: 0,
    });
    expect(parseInputJson('{"t":"pointer","e":"up","x":1,"y":0}')).toEqual({
      t: "pointer",
      e: "up",
      x: 1,
      y: 0,
      b: 0,
    });
  });

  it("parses wheel and key", () => {
    expect(
      parseInputJson('{"t":"wheel","dx":10,"dy":-20,"x":0.1,"y":0.2}'),
    ).toEqual({ t: "wheel", dx: 10, dy: -20, x: 0.1, y: 0.2 });
    expect(
      parseInputJson('{"t":"key","e":"down","key":"a","code":"KeyA"}'),
    ).toEqual({ t: "key", e: "down", key: "a", code: "KeyA" });
  });

  it("parses clipboard text and image", () => {
    expect(parseInputJson('{"t":"clipboard","text":"hi"}')).toEqual({
      t: "clipboard",
      text: "hi",
    });
    expect(
      parseInputJson('{"t":"clipboard","mime":"image/png","data":"QQ=="}'),
    ).toEqual({ t: "clipboard", mime: "image/png", data: "QQ==" });
  });

  it("parses resize, cssScaling, settings, audioDevice, pipeline", () => {
    expect(parseInputJson('{"t":"resize","w":1920,"h":1080,"id":"screen-1","mode":"manual"}')).toEqual({
      t: "resize", w: 1920, h: 1080, id: "screen-1", mode: "manual",
    });
    expect(parseInputJson('{"t":"resize","w":800,"h":600,"id":"","mode":"manual"}')).toBeNull();
    expect(parseInputJson(JSON.stringify({t:"resize",w:800,h:600,id:"x".repeat(65)}))).toBeNull();
    expect(parseInputJson('{"t":"resize","w":800,"h":600,"mode":"other"}')).toBeNull();
    expect(parseInputJson('{"t":"resize","w":1920,"h":1080}')).toEqual({
      t: "resize",
      w: 1920,
      h: 1080,
    });
    expect(
      parseInputJson('{"t":"resize","w":800,"h":600,"reset":true}'),
    ).toEqual({ t: "resize", w: 800, h: 600, reset: true });
    expect(parseInputJson('{"t":"cssScaling","value":true}')).toEqual({
      t: "cssScaling",
      value: true,
    });
    expect(
      parseInputJson('{"t":"settings","settings":{"jpeg_quality":40}}'),
    ).toEqual({ t: "settings", settings: { jpeg_quality: 40 } });
    expect(
      parseInputJson(
        '{"t":"audioDevice","context":"input","deviceId":"default"}',
      ),
    ).toEqual({
      t: "audioDevice",
      context: "input",
      deviceId: "default",
    });
    expect(
      parseInputJson('{"t":"pipeline","pipeline":"audio","enabled":false}'),
    ).toEqual({ t: "pipeline", pipeline: "audio", enabled: false });
  });

  it("parses mic, webcam, and file", () => {
    expect(
      parseInputJson('{"t":"mic","mime":"audio/webm","data":"YQ=="}'),
    ).toEqual({ t: "mic", mime: "audio/webm", data: "YQ==" });
    expect(
      parseInputJson('{"t":"webcam","mime":"image/jpeg","data":"YQ=="}'),
    ).toEqual({ t: "webcam", mime: "image/jpeg", data: "YQ==" });
    expect(
      parseInputJson(
        '{"t":"file","name":"a.txt","mime":"text/plain","data":"YQ=="}',
      ),
    ).toEqual({
      t: "file",
      name: "a.txt",
      mime: "text/plain",
      data: "YQ==",
    });
  });

  it("normalizes ctrl-alt-delete spellings like the viewer", () => {
    expect(normalizeCommand("ctrl-alt-delete")).toBe("ctrl-alt-delete");
    expect(normalizeCommand("Ctrl+Alt+Del")).toBe("ctrl-alt-delete");
    expect(normalizeCommand("CTRL_ALT_DELETE")).toBe("ctrl-alt-delete");
    expect(normalizeCommand("ctrlaltdel")).toBe("ctrl-alt-delete");
    expect(normalizeCommand("other")).toBe("other");

    expect(
      parseInputJson('{"t":"command","command":"Ctrl+Alt+Del"}'),
    ).toEqual({ t: "command", command: "ctrl-alt-delete" });
    expect(
      parseInputJson('{"t":"command","command":"ctrl-alt-delete"}'),
    ).toEqual({ t: "command", command: "ctrl-alt-delete" });
    expect(parseInputJson('{"t":"command","value":"CtrlAltDelete"}')).toEqual({
      t: "command",
      command: "ctrl-alt-delete",
    });
    expect(parseInputJson('{"t":"command","command":"lock"}')).toEqual({
      t: "command",
      command: "lock",
    });
  });

  it("returns null on garbage", () => {
    expect(parseInputJson("not-json")).toBeNull();
    expect(parseInputJson("[]")).toBeNull();
    expect(parseInputJson("{}")).toBeNull();
    expect(parseInputJson('{"t":"pointer","e":"click","x":0,"y":0}')).toBeNull();
    expect(parseInputJson('{"t":"key","e":"down"}')).toBeNull();
    expect(parseInputPayload(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(parseInputPayload(utf8('{"t":"nope"}'))).toBeNull();
  });

  it("parses from UTF-8 bytes", () => {
    expect(
      parseInputPayload(utf8('{"t":"pointer","e":"move","x":0,"y":0,"b":0}')),
    ).toEqual({ t: "pointer", e: "move", x: 0, y: 0, b: 0 });
  });
});

it('accepts bounded latency ping IDs and rejects invalid IDs', () => {
  expect(parseInputJson(JSON.stringify({t:'ping',id:'probe-123',extra:'ignored'}))).toEqual({t:'ping',id:'probe-123'});
  for (const id of ['', 'x'.repeat(65), 123, null]) {
    expect(parseInputJson(JSON.stringify({t:'ping',id}))).toBeNull();
  }
});

it("parses Option A filesList and filesGet inputs", () => {
  expect(parseInputJson('{"t":"filesList"}')).toEqual({ t: "filesList" });
  expect(parseInputJson('{"t":"filesGet","name":"report.txt"}')).toEqual({
    t: "filesGet",
    name: "report.txt",
  });
  expect(parseInputJson('{"t":"filesGet"}')).toBeNull();
});
