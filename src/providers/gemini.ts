/**
 * Google Gemini API (POST /models/{model}:generateContent).
 *
 * Differences handled here: messages become `contents` with roles user/model,
 * the system prompt is `systemInstruction`, sampling lives under
 * `generationConfig`, and streaming uses the `:streamGenerateContent?alt=sse`
 * endpoint. Auth (x-goog-api-key) is set on the transport in unified.ts.
 */

import type { Transport } from "../core/http.js";
import type { GenerateParams, GenerateResult, StreamChunk } from "../core/types.js";
import { splitSystem } from "./shared.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function buildBody(params: GenerateParams): Record<string, unknown> {
  const { system, rest } = splitSystem(params.messages);
  return {
    contents: rest.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    ...(system !== undefined ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { maxOutputTokens: params.maxTokens } : {}),
    },
  };
}

type GeminiCandidate = NonNullable<GeminiResponse["candidates"]>[number];

function textOf(candidate: GeminiCandidate | undefined): string {
  return (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
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
  return {
    text: textOf(candidate),
    model,
    usage: {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    },
    finishReason: mapFinishReason(candidate?.finishReason),
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

  for await (const data of events) {
    let chunk: GeminiResponse;
    try {
      chunk = JSON.parse(data) as GeminiResponse;
    } catch {
      continue;
    }

    const delta = textOf(chunk.candidates?.[0]);
    const usage = chunk.usageMetadata
      ? {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        }
      : undefined;

    if (delta || usage) yield { delta, usage };
  }
}

function mapFinishReason(reason: string | undefined): GenerateResult["finishReason"] {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    // "STOP", undefined, etc. → normal stop.
    default:
      return "stop";
  }
}
