/**
 * Anthropic Messages API (POST /messages).
 *
 * Differences from the OpenAI format handled here: the system prompt is a
 * top-level `system` field, `max_tokens` is required, content is a list of
 * blocks rather than a string, tool results are carried on *user* messages,
 * and streaming uses typed events. Auth headers (x-api-key +
 * anthropic-version) are set on the transport in unified.ts.
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
import { DEFAULT_MAX_TOKENS, ToolCallAccumulator, splitSystem } from "./shared.js";

interface AnthropicResponse {
  model?: string;
  content?: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Build Anthropic's content-block message list from our normalized messages. */
function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: Array<{ role: string; content: unknown[] }> = [];

  for (const m of messages) {
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      // Anthropic carries tool results on a user turn, and consecutive results
      // must be merged into one message rather than sent as separate turns.
      const last = out[out.length - 1];
      if (last?.role === "user" && last.content.every(isToolResult)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      }
      out.push({ role: "assistant", content });
      continue;
    }

    out.push({ role: m.role, content: [{ type: "text", text: m.content }] });
  }

  return out;
}

function isToolResult(block: unknown): boolean {
  return (block as { type?: string })?.type === "tool_result";
}

function toAnthropicTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function toAnthropicToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === "object") return { type: "tool", name: choice.name };
  switch (choice) {
    case "required":
      return { type: "any" };
    case "none":
      return { type: "none" };
    default:
      return { type: "auto" };
  }
}

/** Build the shared request body (minus the `stream` flag). */
function buildBody(model: string, params: GenerateParams): Record<string, unknown> {
  const { system, rest } = splitSystem(params.messages);
  const hasTools = Boolean(params.tools?.length);
  return {
    model,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(rest),
    ...(system !== undefined ? { system } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(hasTools ? { tools: toAnthropicTools(params.tools!) } : {}),
    ...(hasTools && params.toolChoice !== undefined
      ? { tool_choice: toAnthropicToolChoice(params.toolChoice) }
      : {}),
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

  const blocks = res.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  // Anthropic returns tool arguments already parsed, as `input`.
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b, i) => ({
      id: b.id ?? `call_${i}`,
      name: b.name ?? "",
      arguments: b.input ?? {},
    }));

  return {
    text,
    model: res.model ?? model,
    usage: {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    },
    toolCalls,
    finishReason: mapStopReason(res.stop_reason, toolCalls.length > 0),
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

  const tools = new ToolCallAccumulator();
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;

  for await (const data of events) {
    let evt: {
      type?: string;
      index?: number;
      message?: { usage?: { input_tokens?: number } };
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { text?: string; partial_json?: string };
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

      case "content_block_start":
        // A tool_use block opens with its id and name; arguments follow as
        // input_json_delta fragments on the same index.
        if (evt.content_block?.type === "tool_use") {
          tools.open(
            evt.index ?? 0,
            evt.content_block.id ?? `call_${evt.index ?? 0}`,
            evt.content_block.name ?? "",
          );
        }
        break;

      case "content_block_delta": {
        if (evt.delta?.partial_json !== undefined) {
          tools.push(evt.index ?? 0, evt.delta.partial_json);
        } else if (evt.delta?.text) {
          yield { delta: evt.delta.text };
        }
        break;
      }

      case "message_delta":
        outputTokens = evt.usage?.output_tokens ?? 0;
        sawUsage = true;
        break;

      default:
        break;
    }
  }

  const toolCalls = tools.size ? tools.finish() : undefined;
  if (sawUsage || toolCalls) {
    yield {
      delta: "",
      ...(sawUsage ? { usage: { inputTokens, outputTokens } } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    };
  }
}

function mapStopReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): GenerateResult["finishReason"] {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    default:
      return hasToolCalls ? "tool_use" : "stop";
  }
}
