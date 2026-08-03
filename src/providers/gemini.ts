/**
 * Google Gemini API (POST /models/{model}:generateContent).
 *
 * Differences handled here: messages become `contents` with roles user/model,
 * the system prompt is `systemInstruction`, sampling lives under
 * `generationConfig`, tools are `functionDeclarations`, and streaming uses the
 * `:streamGenerateContent?alt=sse` endpoint. Auth (x-goog-api-key) is set on
 * the transport in unified.ts.
 *
 * Gemini has no tool-call ids: a functionResponse is matched to its call by
 * function NAME. The SDK synthesizes ids so the public API matches the other
 * providers, and resolves them back to names when sending results.
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
import { splitSystem } from "./shared.js";

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

type GeminiCandidate = NonNullable<GeminiResponse["candidates"]>[number];

function textOf(candidate: GeminiCandidate | undefined): string {
  return (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** Pull function calls out of a candidate's parts, assigning synthetic ids. */
function toolCallsOf(candidate: GeminiCandidate | undefined): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (!part.functionCall) continue;
    const name = part.functionCall.name ?? "";
    calls.push({ id: `call_${calls.length}`, name, arguments: part.functionCall.args ?? {} });
  }
  return calls;
}

/**
 * Gemini expects a functionResponse's payload to be an object. Tool results in
 * this SDK are strings, so parse JSON objects through and wrap anything else.
 */
function toResponsePayload(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON — fall through
  }
  return { result: content };
}

function buildBody(params: GenerateParams): Record<string, unknown> {
  const { system, rest } = splitSystem(params.messages);

  // Tool results reference a call id, but Gemini matches on name — so resolve
  // each id back to the name the model used earlier in the conversation.
  const nameById = new Map<string, string>();
  for (const m of rest) {
    for (const call of m.toolCalls ?? []) nameById.set(call.id, call.name);
  }

  const contents = rest.map((m) => {
    if (m.role === "tool") {
      const name = m.toolCallId ? (nameById.get(m.toolCallId) ?? m.toolCallId) : "";
      return {
        role: "user",
        parts: [{ functionResponse: { name, response: toResponsePayload(m.content) } }],
      };
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        parts.push({ functionCall: { name: c.name, args: c.arguments } });
      }
      return { role: "model", parts };
    }

    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    };
  });

  const hasTools = Boolean(params.tools?.length);
  return {
    contents,
    ...(system !== undefined ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { maxOutputTokens: params.maxTokens } : {}),
    },
    ...(hasTools ? { tools: [{ functionDeclarations: toGeminiTools(params.tools!) }] } : {}),
    ...(hasTools && params.toolChoice !== undefined
      ? { toolConfig: { functionCallingConfig: toGeminiToolConfig(params.toolChoice) } }
      : {}),
  };
}

function toGeminiTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

function toGeminiToolConfig(choice: ToolChoice): Record<string, unknown> {
  if (typeof choice === "object") {
    return { mode: "ANY", allowedFunctionNames: [choice.name] };
  }
  switch (choice) {
    case "required":
      return { mode: "ANY" };
    case "none":
      return { mode: "NONE" };
    default:
      return { mode: "AUTO" };
  }
}

export async function geminiGenerate(
  transport: Transport,
  model: string,
  params: GenerateParams,
): Promise<GenerateResult> {
  const res = await transport.request<GeminiResponse>(`/models/${model}:generateContent`, {
    method: "POST",
    body: buildBody(params),
    signal: params.signal,
  });

  const candidate = res.candidates?.[0];
  const toolCalls = toolCallsOf(candidate);

  return {
    text: textOf(candidate),
    model,
    usage: {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    },
    toolCalls,
    finishReason: mapFinishReason(candidate?.finishReason, toolCalls.length > 0),
  };
}

export async function* geminiStream(
  transport: Transport,
  model: string,
  params: GenerateParams,
): AsyncIterable<StreamChunk> {
  const events = transport.stream(`/models/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    body: buildBody(params),
    signal: params.signal,
  });

  const toolCalls: ToolCall[] = [];
  let usage: StreamChunk["usage"];

  for await (const data of events) {
    let chunk: GeminiResponse;
    try {
      chunk = JSON.parse(data) as GeminiResponse;
    } catch {
      continue;
    }

    const candidate = chunk.candidates?.[0];

    // Unlike OpenAI/Anthropic, Gemini streams each functionCall whole rather
    // than as JSON fragments, so there is nothing to accumulate.
    for (const part of candidate?.content?.parts ?? []) {
      if (!part.functionCall) continue;
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        name: part.functionCall.name ?? "",
        arguments: part.functionCall.args ?? {},
      });
    }

    if (chunk.usageMetadata) {
      usage = {
        inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
        outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
      };
    }

    const delta = textOf(candidate);
    if (delta) yield { delta };
  }

  if (usage || toolCalls.length) {
    yield {
      delta: "",
      ...(usage ? { usage } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}

function mapFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean,
): GenerateResult["finishReason"] {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      // Gemini reports STOP even when the turn is a function call.
      return hasToolCalls ? "tool_use" : "stop";
  }
}
