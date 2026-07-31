/**
 * The OpenAI Chat Completions wire format, shared by OpenAI, xAI, Mistral,
 * DeepSeek, Alibaba (Qwen) and Meta (Llama). One mapping serves all six —
 * only the base URL differs (see PROVIDER_BASE_URLS).
 */

import type { Transport } from "../core/http.js";
import type { GenerateParams, GenerateResult, StreamChunk } from "../core/types.js";

/** Minimal shape of a /chat/completions response — only what we consume. */
interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Non-streaming generation against an OpenAI-compatible endpoint.
 *
 * `model` is the bare model name (the part after "<company>/"); the provider is
 * already encoded in the transport's base URL.
 */
export async function openAICompatibleGenerate(
  transport: Transport,
  model: string,
  params: GenerateParams,
): Promise<GenerateResult> {
  // Our Message shape ({ role, content }) is already the OpenAI message shape.
  const res = await transport.request<ChatCompletionResponse>("/chat/completions", {
    method: "POST",
    body: {
      model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream: false,
    },
    signal: params.signal,
  });

  const choice = res.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    model: res.model ?? model,
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    },
    finishReason: mapFinishReason(choice?.finish_reason),
  };
}

/** One streamed chunk of a /chat/completions response. */
interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * Streaming generation against an OpenAI-compatible endpoint.
 *
 * `stream_options.include_usage` asks for a final usage chunk; providers that
 * don't support it simply omit usage, which we tolerate.
 */
export async function* openAICompatibleStream(
  transport: Transport,
  model: string,
  params: GenerateParams,
): AsyncIterable<StreamChunk> {
  const events = transport.stream("/chat/completions", {
    method: "POST",
    body: {
      model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    },
    signal: params.signal,
  });

  for await (const data of events) {
    if (data === "[DONE]") return;

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch {
      continue; // ignore keep-alives / non-JSON events
    }

    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    const usage = chunk.usage
      ? {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      : undefined;

    if (delta || usage) yield { delta, usage };
  }
}

/** Normalize OpenAI finish reasons to the SDK's enum. */
function mapFinishReason(reason: string | null | undefined): GenerateResult["finishReason"] {
  switch (reason) {
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    // "stop", "tool_calls", null, or anything else → treat as a normal stop.
    default:
      return "stop";
  }
}
