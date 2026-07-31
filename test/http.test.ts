import { afterEach, describe, expect, it, vi } from "vitest";
import { Transport } from "../src/core/http.js";
import {
  APIError,
  AuthenticationError,
  NeoError,
  RateLimitError,
  TimeoutError,
} from "../src/core/errors.js";
import { jsonResponse, mockFetch, sseResponse } from "./helpers.js";

const BASE = "https://api.example.com/v1";

afterEach(() => vi.unstubAllGlobals());

/** 429 with `retry-after: 0` keeps retry tests instant instead of backing off ~1s. */
function retryableResponse(status = 429): Response {
  return new Response(JSON.stringify({ error: { message: "slow down" } }), {
    status,
    headers: { "content-type": "application/json", "retry-after": "0" },
  });
}

describe("Transport.request", () => {
  it("joins base URL and path without doubling slashes", async () => {
    const fetchMock = mockFetch([jsonResponse({ ok: true })]);
    await new Transport({ baseURL: "https://api.example.com/v1/" }).request("/chat", {
      method: "POST",
    });
    expect(fetchMock.one.url).toBe("https://api.example.com/v1/chat");
  });

  it("sends JSON with merged transport and per-request headers", async () => {
    const fetchMock = mockFetch([jsonResponse({})]);
    await new Transport({ baseURL: BASE, headers: { "x-api-key": "k" } }).request("/chat", {
      method: "POST",
      body: { hello: "world" },
      headers: { "x-extra": "1" },
    });

    const req = fetchMock.one;
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-api-key"]).toBe("k");
    expect(req.headers["x-extra"]).toBe("1");
    expect(req.body).toEqual({ hello: "world" });
  });

  it("returns the parsed JSON body", async () => {
    mockFetch([jsonResponse({ answer: 42 })]);
    await expect(new Transport({ baseURL: BASE }).request("/x")).resolves.toEqual({ answer: 42 });
  });

  it("resolves to undefined for an empty body", async () => {
    mockFetch([new Response("", { status: 200 })]);
    await expect(new Transport({ baseURL: BASE }).request("/x")).resolves.toBeUndefined();
  });
});

describe("Transport error mapping", () => {
  it.each([
    [401, AuthenticationError],
    [403, AuthenticationError],
    [429, RateLimitError],
    [500, APIError],
    [400, APIError],
  ])("maps status %i to the right error class", async (status, expected) => {
    mockFetch([jsonResponse({ error: { message: "boom" } }, status)]);
    const promise = new Transport({ baseURL: BASE }).request("/x");
    await expect(promise).rejects.toBeInstanceOf(expected);
    await expect(promise).rejects.toMatchObject({ status });
  });

  it("surfaces the provider's error message", async () => {
    mockFetch([jsonResponse({ error: { message: "invalid model" } }, 400)]);
    await expect(new Transport({ baseURL: BASE }).request("/x")).rejects.toThrow("invalid model");
  });

  it("falls back to a status message when the body has none", async () => {
    mockFetch([new Response("", { status: 502 })]);
    await expect(new Transport({ baseURL: BASE }).request("/x")).rejects.toThrow(/502/);
  });

  it("wraps network failures in NeoError with the cause attached", async () => {
    const cause = new Error("ECONNRESET");
    mockFetch([cause]);
    const promise = new Transport({ baseURL: BASE }).request("/x");
    await expect(promise).rejects.toBeInstanceOf(NeoError);
    await expect(promise).rejects.toMatchObject({ cause });
  });
});

describe("Transport retries", () => {
  it("does not retry when maxRetries is 0 (the default)", async () => {
    const fetchMock = mockFetch([retryableResponse()]);
    await expect(new Transport({ baseURL: BASE }).request("/x")).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("retries a 429 and returns the eventual success", async () => {
    const fetchMock = mockFetch([retryableResponse(), retryableResponse(), jsonResponse({ ok: 1 })]);
    const result = await new Transport({ baseURL: BASE, maxRetries: 2 }).request("/x");
    expect(result).toEqual({ ok: 1 });
    expect(fetchMock.calls).toHaveLength(3);
  });

  it("retries 5xx responses", async () => {
    const fetchMock = mockFetch([retryableResponse(503), jsonResponse({ ok: 1 })]);
    await new Transport({ baseURL: BASE, maxRetries: 1 }).request("/x");
    expect(fetchMock.calls).toHaveLength(2);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const fetchMock = mockFetch([retryableResponse()]);
    await expect(
      new Transport({ baseURL: BASE, maxRetries: 2 }).request("/x"),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock.calls).toHaveLength(3); // initial + 2 retries
  });

  // Retrying a bad request or a bad key just wastes quota — it can't succeed.
  it.each([400, 401, 404])("does not retry status %i", async (status) => {
    const fetchMock = mockFetch([jsonResponse({ error: { message: "nope" } }, status)]);
    await expect(new Transport({ baseURL: BASE, maxRetries: 3 }).request("/x")).rejects.toThrow();
    expect(fetchMock.calls).toHaveLength(1);
  });
});

describe("Transport timeouts", () => {
  it("throws TimeoutError when the request exceeds timeoutMs", async () => {
    // Hang until the transport's own timeout signal aborts the request.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit = {}) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );

    await expect(
      new Transport({ baseURL: BASE, timeoutMs: 10 }).request("/x"),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates the caller's abort instead of retrying", async () => {
    const fetchMock = mockFetch([jsonResponse({})]);
    const controller = new AbortController();
    controller.abort();

    const promise = new Transport({ baseURL: BASE, maxRetries: 3 }).request("/x", {
      signal: controller.signal,
    });

    // A cancelled request must surface as AbortError and must NOT be retried.
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.calls).toHaveLength(1);
  });
});

describe("Transport.stream", () => {
  it("requests SSE and yields each event payload", async () => {
    const fetchMock = mockFetch([sseResponse(["a", "b", "[DONE]"])]);
    const out: string[] = [];
    for await (const data of new Transport({ baseURL: BASE }).stream("/chat", {
      body: { stream: true },
    })) {
      out.push(data);
    }

    expect(out).toEqual(["a", "b", "[DONE]"]);
    expect(fetchMock.one.headers["accept"]).toBe("text/event-stream");
    expect(fetchMock.one.method).toBe("POST");
  });

  it("maps a failed stream handshake to a typed error", async () => {
    mockFetch([jsonResponse({ error: { message: "bad key" } }, 401)]);
    const iterate = async () => {
      for await (const _ of new Transport({ baseURL: BASE }).stream("/chat")) void _;
    };
    await expect(iterate()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("does not retry mid-stream failures", async () => {
    const fetchMock = mockFetch([retryableResponse(500)]);
    const iterate = async () => {
      for await (const _ of new Transport({ baseURL: BASE, maxRetries: 3 }).stream("/chat")) void _;
    };
    await expect(iterate()).rejects.toBeInstanceOf(APIError);
    expect(fetchMock.calls).toHaveLength(1);
  });
});
