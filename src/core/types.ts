/**
 * Shared, provider-agnostic public types.
 *
 * These are the types consumers see. Keep them stable — changing them is a
 * breaking change. Provider-specific shapes belong in src/providers/*, and
 * should be mapped to/from these types at the provider boundary.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A JSON Schema object describing a tool's arguments. Deliberately permissive. */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** A function the model may ask to call. */
export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments object. */
  parameters: JSONSchema;
}

/**
 * How the model should choose tools:
 *   "auto"     — model decides (provider default when tools are present)
 *   "none"     — never call a tool
 *   "required" — must call some tool
 *   { name }   — must call this specific tool
 */
export type ToolChoice = "auto" | "none" | "required" | { name: string };

/** A model's request to invoke one tool. */
export interface ToolCall {
  /**
   * Correlation id, echoed back on the matching tool-result message.
   * Gemini has no native ids, so the SDK synthesizes one there.
   */
  id: string;
  name: string;
  /** Parsed arguments object. Malformed JSON from the model throws instead. */
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  /** Text content. Empty string is valid when an assistant only calls tools. */
  content: string;
  /** Assistant only: tools the model asked to call. */
  toolCalls?: ToolCall[];
  /** Tool only: the id of the ToolCall this message answers. */
  toolCallId?: string;
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
  /** Tools the model may call. */
  tools?: Tool[];
  /** Constrains tool selection. Ignored when `tools` is empty. */
  toolChoice?: ToolChoice;
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
  /** Tools the model asked to call. Empty when it produced only text. */
  toolCalls: ToolCall[];
  /** Why generation stopped, normalized across providers. */
  finishReason: "stop" | "length" | "content_filter" | "tool_use" | "error";
}

/** One incremental piece of a streamed response. */
export interface StreamChunk {
  /** Text delta for this chunk (may be empty on non-text events). */
  delta: string;
  /** Present only on the final chunk. */
  usage?: Usage;
  /**
   * Complete tool calls, emitted once at the end of the stream.
   *
   * Providers stream tool arguments as JSON fragments; the SDK accumulates
   * them and only surfaces calls once they parse, so consumers never see a
   * half-built arguments object.
   */
  toolCalls?: ToolCall[];
}
