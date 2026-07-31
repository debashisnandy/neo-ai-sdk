/**
 * Shared, provider-agnostic public types.
 *
 * These are the types consumers see. Keep them stable — changing them is a
 * breaking change. Provider-specific shapes belong in src/providers/*, and
 * should be mapped to/from these types at the provider boundary.
 */

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface GenerateParams<TModel extends string = string> {
  /**
   * Model identifier. Defaults to a plain string, but callers (and the
   * UnifiedProvider) can pin it to a stricter type such as `ProviderModelId`
   * so an unknown "<company>/..." prefix becomes a compile-time error.
   */
  model: TModel;
  messages: Message[];
  /** Sampling temperature, 0–1. Optional; provider default applies when omitted. */
  temperature?: number;
  maxTokens?: number;
  /** Abort in-flight requests. Wired through to the transport's fetch call. */
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: Usage;
  /** Why generation stopped, normalized across providers. */
  finishReason: "stop" | "length" | "content_filter" | "error";
}

/** One incremental piece of a streamed response. */
export interface StreamChunk {
  /** Text delta for this chunk (may be empty on non-text events). */
  delta: string;
  /** Present only on the final chunk. */
  usage?: Usage;
}
