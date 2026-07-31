/**
 * Thin transport layer over global fetch (Node >=20.11 ships it natively).
 *
 * All network I/O goes through here so retries, timeouts, auth headers, and
 * error mapping live in one place instead of being duplicated per provider.
 */

import { NeoError, TimeoutError, errorFromResponse } from "./errors.js";
import { parseSSE } from "./stream.js";

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Per-request timeout in ms. Falls back to the transport default. */
  timeoutMs?: number;
}

export interface TransportOptions {
  baseURL: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Max retry attempts for retryable failures (429 / 5xx / network). */
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class Transport {
  constructor(private readonly opts: TransportOptions) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = joinURL(this.opts.baseURL, path);
    const maxRetries = this.opts.maxRetries ?? 0;
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers = {
      "content-type": "application/json",
      ...this.opts.headers,
      ...options.headers,
    };
    const method = options.method ?? "GET";
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body,
          signal: combineSignals(options.signal, timeoutMs),
        });

        if (res.ok) return (await parseJson(res)) as T;

        const errBody = await parseJson(res);
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw errorFromResponse(res.status, errBody);
      } catch (err) {
        // Errors we produced (bad status, etc.) propagate as-is.
        if (err instanceof NeoError) throw err;

        const name = (err as { name?: string } | undefined)?.name;
        if (name === "AbortError") throw err; // caller cancelled via their signal
        if (name === "TimeoutError") {
          throw new TimeoutError(`Request to ${url} timed out after ${timeoutMs}ms`);
        }

        // Network-level failure (DNS, connection reset, …): retry if allowed.
        if (attempt < maxRetries) {
          await sleep(retryDelayMs(attempt, null));
          continue;
        }
        throw new NeoError(`Request to ${url} failed`, { cause: err });
      }
    }
  }

  /**
   * Open a streaming request and yield each SSE event's `data` payload.
   *
   * Unlike request(), this does not retry mid-stream, and it only applies a
   * timeout when one is explicitly given — a default total timeout would cut
   * off long generations. The caller's abort signal is always honored.
   */
  async *stream(path: string, options: RequestOptions = {}): AsyncIterable<string> {
    const url = joinURL(this.opts.baseURL, path);
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.opts.headers,
      ...options.headers,
    };
    const signal = options.timeoutMs
      ? combineSignals(options.signal, options.timeoutMs)
      : options.signal;

    let res: Response;
    try {
      res = await fetch(url, {
        method: options.method ?? "POST",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (err) {
      const name = (err as { name?: string } | undefined)?.name;
      if (name === "AbortError") throw err;
      if (name === "TimeoutError") throw new TimeoutError(`Stream to ${url} timed out`);
      throw new NeoError(`Stream request to ${url} failed`, { cause: err });
    }

    if (!res.ok) throw errorFromResponse(res.status, await parseJson(res));
    if (!res.body) throw new NeoError(`Stream to ${url} returned no body`);

    yield* parseSSE(res.body);
  }
}

function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/** Combine the caller's abort signal (if any) with a timeout signal. */
function combineSignals(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Read a response body as JSON, falling back to raw text, then undefined. */
async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Exponential backoff with jitter; honors a numeric Retry-After (seconds). */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.random() * base * 0.25;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
