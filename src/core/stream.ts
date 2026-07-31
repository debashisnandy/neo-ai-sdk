/**
 * Server-Sent Events (SSE) parsing. Turns a byte stream into the string
 * payloads of each event's `data:` field — the format every provider here uses
 * for streaming. Mapping those payloads into StreamChunks is provider-specific
 * and lives with each provider.
 */

/**
 * Parse an SSE response body, yielding each event's decoded `data` value.
 * Multi-line `data:` fields are joined with "\n". Comments (`:`), `event:`,
 * `id:` and `retry:` lines are ignored.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      // Events are separated by a blank line.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = dataOf(event);
        if (data !== undefined) yield data;
      }
    }

    // Flush any trailing event without a final blank line.
    const data = dataOf(buffer);
    if (data !== undefined) yield data;
  } finally {
    reader.releaseLock();
  }
}

/** Collect the `data:` lines of one raw SSE event, or undefined if none. */
function dataOf(rawEvent: string): string | undefined {
  const lines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      // Spec: a single leading space after the colon is stripped.
      lines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}
