/**
 * Error hierarchy. Everything the SDK throws extends NeoError so consumers can
 * `catch (e) { if (e instanceof NeoError) ... }` and narrow from there.
 */

export class NeoError extends Error {
  override name = "NeoError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Non-2xx HTTP response from a provider. */
export class APIError extends NeoError {
  override name = "APIError";
  constructor(
    message: string,
    readonly status: number,
    /** Raw parsed response body, if any — useful for debugging provider quirks. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class AuthenticationError extends APIError {
  override name = "AuthenticationError";
}

export class RateLimitError extends APIError {
  override name = "RateLimitError";
  /** Seconds to wait before retrying, parsed from Retry-After when present. */
  retryAfter?: number;
}

export class TimeoutError extends NeoError {
  override name = "TimeoutError";
}

/** Pull a human-readable message out of a provider error body, if present. */
function messageFromBody(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // OpenAI-compatible shape: { error: { message } }
    const err = b["error"];
    if (err && typeof err === "object") {
      const m = (err as Record<string, unknown>)["message"];
      if (typeof m === "string") return m;
    }
    if (typeof b["message"] === "string") return b["message"] as string;
  }
  return undefined;
}

/**
 * Map an HTTP status + parsed body to the right error subclass so every
 * provider reports failures consistently.
 */
export function errorFromResponse(status: number, body: unknown): APIError {
  const message = messageFromBody(body) ?? `Request failed with status ${status}`;
  if (status === 401 || status === 403) return new AuthenticationError(message, status, body);
  if (status === 429) return new RateLimitError(message, status, body);
  return new APIError(message, status, body);
}
