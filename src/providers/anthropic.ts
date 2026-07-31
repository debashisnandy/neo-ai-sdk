/**
 * Anthropic Messages API (POST /messages).
 *
 * Differences from the OpenAI format handled here: the system prompt is a
 * top-level `system` field, `max_tokens` is required, response text arrives as
 * `content` blocks, and streaming uses typed events. Auth headers (x-api-key +
 * anthropic-version) are set on the transport in unified.ts.
 */

import type { Transport } from "../core/http.js";
import type { GenerateParams, GenerateResult, StreamChunk } from "../core/types.js";
import { DEFAULT_MAX_TOKENS, splitSystem } from "./shared.js";

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Build the shared request body (minus the `stream` flag). */
function buildBody(model: string, params: GenerateParams): Record<string, unknown> {
  const { system, rest } = splitSystem(params.messages);
  return {
    model,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: rest.map((m) => ({ role: m.role, content: m.content })),
    ...(system !== undefined ? { system } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
  };
}

export async function anthropicGenerate(
  transport: Transport,
  model: string,
  params: GenerateParams,
): Promise<GenerateResult> {
  const res = await transport.request<AnthropicResponse>("/messages", {
    method: "POST",
    body: { ...buildBody(model, params), stream: false },
    signal: params.signal,
  });

  const text = (res.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  return {
    text,
    model: res.model ?? model,
    usage: {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    },
    finishReason: mapStopReason(res.stop_reason),
  };
}

export async function* anthropicStream(
  transport: Transport,
  model: string,
  params: GenerateParams,
): AsyncIterable<StreamChunk> {
  const events = transport.stream("/messages", {
    method: "POST",
    body: { ...buildBody(model, params), stream: true },
    signal: params.signal,
  });

  let inputTokens = 0;

  for await (const data of events) {
    let evt: {
      type?: string;
      message?: { usage?: { input_tokens?: number } };
      delta?: { text?: string };
      usage?: { output_tokens?: number };
    };
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }

    switch (evt.type) {
      case "message_start":
        inputTokens = evt.message?.usage?.input_tokens ?? 0;
        break;
      case "content_block_delta": {
        const text = evt.delta?.text;
        if (text) yield { delta: text };
        break;
      }
      case "message_delta":
        // Carries the final output token count near the end of the stream.
        yield { delta: "", usage: { inputTokens, outputTokens: evt.usage?.output_tokens ?? 0 } };
        break;
      default:
        break;
    }
  }
}

function mapStopReason(reason: string | null | undefined): GenerateResult["finishReason"] {
  switch (reason) {
    case "max_tokens":
      return "length";
    // "end_turn", "stop_sequence", "tool_use", null → normal stop.
    default:
      return "stop";
  }
}
