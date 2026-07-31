/** Small helpers shared by providers that don't use the OpenAI wire format. */

import type { Message } from "../core/types.js";

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
