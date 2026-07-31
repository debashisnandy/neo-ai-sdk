import { describe, expect, it } from "vitest";
import { parseSSE } from "../src/core/stream.js";

/** Build a ReadableStream that emits the given strings as separate byte chunks. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSSE(stream)) out.push(data);
  return out;
}

describe("parseSSE", () => {
  it("yields the data payload of each event", async () => {
    expect(await collect(streamOf("data: one\n\ndata: two\n\n"))).toEqual(["one", "two"]);
  });

  // The critical case: network chunks don't align with event boundaries.
  it("reassembles events split across byte chunks", async () => {
    expect(await collect(streamOf("data: hel", "lo\n", "\ndata: wor", "ld\n\n"))).toEqual([
      "hello",
      "world",
    ]);
  });

  it("handles a multi-byte character split across chunks", async () => {
    // "é" is 0xC3 0xA9 — split it so the decoder must buffer the partial byte.
    const encoder = new TextEncoder();
    const bytes = encoder.encode("data: café\n\n");
    const split = bytes.length - 4;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual(["café"]);
  });

  it("joins multi-line data fields with a newline", async () => {
    expect(await collect(streamOf("data: line1\ndata: line2\n\n"))).toEqual(["line1\nline2"]);
  });

  it("accepts CRLF line endings", async () => {
    expect(await collect(streamOf("data: one\r\n\r\ndata: two\r\n\r\n"))).toEqual(["one", "two"]);
  });

  it("strips only one leading space after the colon", async () => {
    expect(await collect(streamOf("data:  padded\n\n"))).toEqual([" padded"]);
  });

  it("accepts data with no space after the colon", async () => {
    expect(await collect(streamOf("data:tight\n\n"))).toEqual(["tight"]);
  });

  it("ignores comments and non-data fields", async () => {
    const raw = ": keep-alive\n\nevent: ping\nid: 1\nretry: 500\n\ndata: real\n\n";
    expect(await collect(streamOf(raw))).toEqual(["real"]);
  });

  it("flushes a trailing event with no final blank line", async () => {
    expect(await collect(streamOf("data: last"))).toEqual(["last"]);
  });

  it("preserves JSON payloads verbatim, including colons and braces", async () => {
    const payload = '{"a":1,"b":"x: y"}';
    expect(await collect(streamOf(`data: ${payload}\n\n`))).toEqual([payload]);
  });

  it("yields nothing for an empty stream", async () => {
    expect(await collect(streamOf(""))).toEqual([]);
  });
});
