/**
 * The OpenAI Chat Completions wire format, shared by OpenAI, xAI, Mistral,
 * DeepSeek, Alibaba (Qwen) and Meta (Llama). One mapping serves all six —
 * only the base URL differs (see PROVIDER_BASE_URLS).
 */

import type { Transport } from "../core/http.js";
import type {
  GenerateParams,
  GenerateResult,
  Message,
  StreamChunk,
  Tool,
  ToolCall,
  ToolChoice,
} from "../core/types.js";
import { ToolCallAccumulator, parseToolArguments } from "./shared.js";
import {
  describeSchema,
  parseOutput,
  resolveOutput,
  type OutputSchema,
} from "../core/output.js";

/** Minimal shape of a /chat/completions response — only what we consume. */
interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** One streamed chunk of a /chat/completions response. */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Translate our normalized messages into OpenAI's message list. */
function toOpenAIMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAITools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toOpenAIToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === "object") {
    return { type: "function", function: { name: choice.name } };
  }
  return choice; // "auto" | "none" | "required" map one-to-one
}

/** Shared request body for both generate() and stream(). */
function buildBody(model: string, params: GenerateParams): Record<string, unknown> {
  const hasTools = Boolean(params.tools?.length);
  const output = params.output ? resolveOutput(params.output) : undefined;

  return {
    model,
    messages: toOpenAIMessages(params.messages),
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    ...(hasTools ? { tools: toOpenAITools(params.tools!) } : {}),
    ...(hasTools && params.toolChoice !== undefined
      ? { tool_choice: toOpenAIToolChoice(params.toolChoice) }
      : {}),
    // Native structured output: the provider constrains decoding to the schema.
    ...(output ? { response_format: toResponseFormat(output) } : {}),
  };
}

function toResponseFormat(output: OutputSchema): unknown {
  const { name, description, schema } = describeSchema(output);
  return {
    type: "json_schema",
    json_schema: {
      name,
      ...(description ? { description } : {}),
      schema,
      // Ask the provider to guarantee conformance rather than merely suggest it.
      strict: true,
    },
  };
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
  const res = await transport.request<ChatCompletionResponse>("/chat/completions", {
    method: "POST",
    body: { ...buildBody(model, params), stream: false },
    signal: params.signal,
  });

  const choice = res.choices?.[0];
  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c, i) => {
    const name = c.function?.name ?? "";
    return {
      id: c.id ?? `call_${i}`,
      name,
      arguments: parseToolArguments(name, c.function?.arguments ?? ""),
    };
  });

  const text = choice?.message?.content ?? "";
  const output = params.output ? resolveOutput(params.output) : undefined;

  return {
    text,
    model: res.model ?? model,
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    },
    toolCalls,
    ...(output ? { object: parseOutput(output, text) } : {}),
    finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
  };
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
      ...buildBody(model, params),
      stream: true,
      stream_options: { include_usage: true },
    },
    signal: params.signal,
  });

  const tools = new ToolCallAccumulator();
  let usage: StreamChunk["usage"];

  for await (const data of events) {
    if (data === "[DONE]") break;

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(data) as ChatCompletionChunk;
    } catch {
      continue; // ignore keep-alives / non-JSON events
    }

    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;

    // Tool calls stream as fragments keyed by index: the first event for an
    // index carries id/name, later ones extend the arguments JSON.
    for (const [i, call] of (delta?.tool_calls ?? []).entries()) {
      const index = call.index ?? i;
      if (call.id || call.function?.name) {
        tools.open(index, call.id ?? `call_${index}`, call.function?.name ?? "");
      }
      if (call.function?.arguments) tools.push(index, call.function.arguments);
    }

    const text = delta?.content ?? "";
    if (text) yield { delta: text };
  }

  // Emit accumulated tool calls (and usage) once, at the end.
  const toolCalls = tools.size ? tools.finish() : undefined;
  if (toolCalls || usage) yield { delta: "", ...(usage ? { usage } : {}), ...(toolCalls ? { toolCalls } : {}) };
}

/** Normalize OpenAI finish reasons to the SDK's enum. */
function mapFinishReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): GenerateResult["finishReason"] {
  switch (reason) {
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      // Some providers report "stop" even when they emitted tool calls.
      return hasToolCalls ? "tool_use" : "stop";
  }
}
