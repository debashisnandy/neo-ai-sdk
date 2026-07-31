/**
 * Test helpers: a stub for global fetch, so tests exercise the real Transport
 * and the real provider mapping without touching the network.
 */

import { vi } from "vitest";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON request body, when one was sent. */
  body: any;
}

export interface FetchMock {
  /** Every request the SDK made, in order. */
  calls: CapturedRequest[];
  /** The single request — asserts exactly one was made. */
  readonly one: CapturedRequest;
}

/** Build a JSON Response. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build an SSE Response whose body streams each payload as one `data:` event. */
export function sseResponse(payloads: unknown[], status = 200): Response {
  const text = payloads
    .map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`)
    .join("");
  return new Response(text, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Replace global fetch for the duration of a test.
 *
 * `responses` is consumed in order; a function is called with the captured
 * request so a test can vary its reply. Restored automatically by
 * `vi.restoreAllMocks()` (see test/setup via afterEach in each file).
 */
export function mockFetch(
  responses: Array<Response | Error | ((req: CapturedRequest) => Response | Error)>,
): FetchMock {
  const calls: CapturedRequest[] = [];
  let index = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }

      const captured: CapturedRequest = {
        url: String(url),
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(captured);

      // Honor abort signals so timeout/cancellation tests behave realistically.
      const signal = init.signal;
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");

      const next = responses[Math.min(index++, responses.length - 1)];
      const result = typeof next === "function" ? next(captured) : next;
      if (result instanceof Error) throw result;
      // A Response body can only be read once. Hand out a clone so the same
      // entry can serve repeated calls (retries, or more calls than responses).
      return result.clone();
    }),
  );

  return {
    calls,
    get one() {
      if (calls.length !== 1) {
        throw new Error(`Expected exactly 1 request, got ${calls.length}`);
      }
      return calls[0]!;
    },
  };
}

/** Drain an async iterable of chunks into concatenated text + final usage. */
export async function collectStream(
  stream: AsyncIterable<{ delta: string; usage?: { inputTokens: number; outputTokens: number } }>,
) {
  let text = "";
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const deltas: string[] = [];
  for await (const chunk of stream) {
    text += chunk.delta;
    if (chunk.delta) deltas.push(chunk.delta);
    if (chunk.usage) usage = chunk.usage;
  }
  return { text, deltas, usage };
}
