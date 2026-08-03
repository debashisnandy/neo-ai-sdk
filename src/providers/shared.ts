/** Small helpers shared by providers that don't use the OpenAI wire format. */

import { NeoError } from "../core/errors.js";
import type { Message, ToolCall } from "../core/types.js";

/** Anthropic requires max_tokens; used as a fallback when the caller omits it. */
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * Split "system" messages out of the conversation. Anthropic and Gemini both
 * carry the system prompt in a dedicated top-level field rather than inline.
 */
export function splitSystem(messages: Message[]): { system?: string; rest: Message[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return { system: system.length ? system.join("\n\n") : undefined, rest };
}

/**
 * Parse a tool-call arguments string into an object.
 *
 * Models occasionally emit malformed JSON. Failing loudly is deliberate:
 * defaulting to `{}` would silently run the tool with the wrong arguments,
 * which is far worse than an error naming the tool and showing the raw text.
 */
export function parseToolArguments(name: string, raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new NeoError(
      `Tool "${name}" returned arguments that are not valid JSON: ${truncate(text)}`,
      { cause: err },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NeoError(
      `Tool "${name}" returned arguments that are not a JSON object: ${truncate(text)}`,
    );
  }
  return parsed as Record<string, unknown>;
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Accumulates tool calls streamed as fragments.
 *
 * Both OpenAI and Anthropic stream a tool call as an opening event carrying the
 * id/name, followed by partial JSON strings for the arguments, keyed by an
 * index. Calls are only surfaced once the stream ends and the JSON parses.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  /** Record the start of a tool call at `index`. */
  open(index: number, id: string, name: string): void {
    const existing = this.byIndex.get(index);
    if (existing) {
      // Some providers repeat id/name on later events; keep the first non-empty.
      existing.id ||= id;
      existing.name ||= name;
      return;
    }
    this.byIndex.set(index, { id, name, args: "" });
  }

  /** Append a fragment of the arguments JSON for the call at `index`. */
  push(index: number, argsFragment: string): void {
    const entry = this.byIndex.get(index);
    if (entry) entry.args += argsFragment;
    // A fragment with no opening event has no id/name to attach to; the
    // provider mapper is responsible for calling open() first.
  }

  get size(): number {
    return this.byIndex.size;
  }

  /** Finalize every accumulated call, parsing its arguments. */
  finish(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, { id, name, args }]) => ({
        id,
        name,
        arguments: parseToolArguments(name, args),
      }));
  }
}
