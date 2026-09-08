import { describe, expect, it } from "vitest";
import {
  clipboardTextFromFrame,
  cursorFromFrame,
  encodeFilesGetRequest,
  encodeFilesListRequest,
  fileFromFrame,
  filesGetFromFrame,
  filesListFromFrame,
  isSafeFilesBasename,
  isSafeFilesPath,
  parseJsonFrameObject,
  printFromFrame,
  statsFromFrame,
} from "../src/json-frame";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("json frames (clipboard + cursor)", () => {
  it("parses clipboard text and image the same way as the viewer", () => {
    expect(clipboardTextFromFrame(utf8('{"t":"clipboard","text":"hi"}'))).toEqual({
      kind: "text",
      text: "hi",
    });
    expect(
      clipboardTextFromFrame(
        utf8('{"type":"clipboard","mime":"image/png","data":"QQ=="}'),
      ),
    ).toEqual({ kind: "image", mime: "image/png", data: "QQ==" });
    expect(clipboardTextFromFrame(utf8("\n  {\"t\":\"clipboard\",\"text\":\"x\"}"))).toEqual({
      kind: "text",
      text: "x",
    });
  });

  it("parses cursor JSON frames without a new envelope kind", () => {
    expect(
      cursorFromFrame(
        utf8('{"t":"cursor","visible":true,"hx":2,"hy":3,"mime":"image/png","data":"QQ=="}'),
      ),
    ).toEqual({
      visible: true,
      hx: 2,
      hy: 3,
      mime: "image/png",
      data: "QQ==",
    });
    expect(cursorFromFrame(utf8('{"t":"cursor","visible":false}'))).toEqual({
      visible: false,
      hx: 0,
      hy: 0,
      mime: "",
      data: "",
    });
    expect(cursorFromFrame(utf8('{"type":"cursor"}'))).toEqual({
      visible: true,
      hx: 0,
      hy: 0,
      mime: "",
      data: "",
    });
  });

  it("ignores pixels and other JSON", () => {
    expect(parseJsonFrameObject(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(cursorFromFrame(utf8('{"t":"clipboard","text":"no"}'))).toBeNull();
    expect(clipboardTextFromFrame(utf8('{"t":"cursor","visible":true}'))).toBeNull();
    expect(cursorFromFrame(utf8("placeholder-frame-1"))).toBeNull();
  });

  it("parses file downloads and optional agent stats", () => {
    expect(fileFromFrame(utf8('{"t":"file","name":"report.txt","mime":"text/plain","data":"aGk="}'))).toEqual({
      name: "report.txt",
      mime: "text/plain",
      data: "aGk=",
    });
    expect(statsFromFrame(utf8('{"t":"stats","fps":30,"system":{"cpu_percent":12}}'))).toEqual({
      t: "stats",
      fps: 30,
      system: { cpu_percent: 12 },
    });
  });

  it("parses single-shot print frames with defaults", () => {
    expect(
      printFromFrame(utf8('{"t":"print","mime":"application/pdf","name":"job.pdf","data":"JVBERg=="}')),
    ).toEqual({
      name: "job.pdf",
      mime: "application/pdf",
      data: "JVBERg==",
      job: "single",
      part: 0,
      parts: 1,
    });
    expect(printFromFrame(utf8('{"type":"print","data":"QQ=="}'))).toEqual({
      name: "print.pdf",
      mime: "application/pdf",
      data: "QQ==",
      job: "single",
      part: 0,
      parts: 1,
    });
  });

  it("parses chunked print fields and rejects bad part", () => {
    expect(
      printFromFrame(
        utf8(
          '{"t":"print","job":"j1","part":1,"parts":3,"mime":"application/pdf","name":"a.pdf","data":"YQ=="}',
        ),
      ),
    ).toEqual({
      name: "a.pdf",
      mime: "application/pdf",
      data: "YQ==",
      job: "j1",
      part: 1,
      parts: 3,
    });
    expect(
      printFromFrame(
        utf8('{"t":"print","job":"j1","part":3,"parts":3,"data":"YQ=="}'),
      ),
    ).toBeNull();
    expect(printFromFrame(utf8('{"t":"print"}'))).toBeNull();
    expect(printFromFrame(utf8('{"t":"file","name":"x","data":"YQ=="}'))).toBeNull();
  });
});

describe("files Option A frames", () => {
  it("parses filesList and filesGet success/error frames", () => {
    expect(
      filesListFromFrame(
        utf8('{"t":"filesList","files":[{"name":"a.txt","size":3,"mtime":1000}]}'),
      ),
    ).toEqual({
      t: "filesList",
      path: "",
      files: [{ id: "a.txt", name: "a.txt", type: "file", size: 3, mtime: 1000 }],
    });
    expect(
      filesGetFromFrame(
        utf8('{"t":"filesGet","name":"a.txt","mime":"text/plain","data":"YQ=="}'),
      ),
    ).toEqual({
      t: "filesGet",
      name: "a.txt",
      mime: "text/plain",
      data: "YQ==",
    });
    expect(
      filesGetFromFrame(utf8('{"t":"filesGet","name":"missing","error":"not_found"}')),
    ).toEqual({ t: "filesGet", name: "missing", error: "not_found" });
    expect(filesListFromFrame(utf8('{"t":"file","name":"x","data":"YQ=="}'))).toBeNull();
  });

  it("encodes list/get requests and validates basenames", () => {
    expect(encodeFilesListRequest()).toBe('{"t":"filesList"}');
    expect(encodeFilesGetRequest("report.txt")).toBe(
      '{"t":"filesGet","name":"report.txt"}',
    );
    expect(isSafeFilesBasename("report.txt")).toBe(true);
    expect(isSafeFilesBasename("../x")).toBe(false);
    expect(isSafeFilesBasename("a/b")).toBe(false);
    expect(isSafeFilesBasename("a\\b")).toBe(false);
  });
});


describe("relative file paths", () => {
  it.each(["/a", "a//b", "a/", ".", "..", "a/../b", "a/./b", "a\\b", "C:/a", "a:stream", "a?", "a*", "a<", "a>", 'a"', "a|", "a\n", "a\u007f", "a.", "a ", "CON", "nul.txt", "a/COM1.log", "LPT9", "COM¹", "CONOUT$"])("rejects %j", (path) => {
    expect(isSafeFilesPath(path, true)).toBe(false);
  });
  it("allows root only for list and clean nested names", () => {
    expect(isSafeFilesPath("")).toBe(false);
    expect(isSafeFilesPath("", true)).toBe(true);
    expect(isSafeFilesPath("a/b report..txt")).toBe(true);
    expect(encodeFilesListRequest("a/b")).toBe('{"t":"filesList","path":"a/b"}');
    expect(encodeFilesGetRequest("a/b.txt")).toBe('{"t":"filesGet","name":"a/b.txt"}');
  });
  it("retains child IDs/types and drops unsafe or unrelated entries", () => {
    const dir = { id: "a/b", name: "b", type: "dir", size: 0, mtime: 123 };
    const parsed = filesListFromFrame(utf8(JSON.stringify({ t: "filesList", path: "a", files: [dir,
      { ...dir, name: "../evil" }, { ...dir, id: "elsewhere/b" }, { ...dir, type: "symlink" },
    ] })));
    expect(parsed).toEqual({ t: "filesList", path: "a", files: [dir] });
    expect(filesListFromFrame(utf8('{"t":"filesList","path":"../x","files":[]}'))).toBeNull();
    expect(filesGetFromFrame(utf8('{"t":"filesGet","name":"a/b","data":""}'))?.name).toBe("a/b");
  });
});
