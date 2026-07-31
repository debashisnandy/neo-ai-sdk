/**
 * Wire-format tests: for each provider family, assert we send exactly what the
 * API expects and correctly map what it returns. These are the tests that catch
 * a silently malformed request.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { UnifiedProvider } from "../src/providers/unified.js";
import type { Message } from "../src/core/types.js";
import { collectStream, jsonResponse, mockFetch, sseResponse } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const KEYS = { openai: "sk-openai", anthropic: "sk-ant", gemini: "g-key", deepseek: "sk-ds" };
const provider = () => new UnifiedProvider({ apiKeys: KEYS });

const USER: Message[] = [{ role: "user", content: "hi" }];
const WITH_SYSTEM: Message[] = [
  { role: "system", content: "be brief" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "again" },
];

describe("OpenAI-compatible: generate", () => {
  it("posts chat/completions with the bare model name and Bearer auth", async () => {
    const fetchMock = mockFetch([
      jsonResponse({
        model: "gpt-5",
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }),
    ]);

    const result = await provider().generate({
      model: "openai/gpt-5",
      messages: USER,
      temperature: 0.3,
      maxTokens: 256,
    });

    const req = fetchMock.one;
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["authorization"]).toBe("Bearer sk-openai");
    // The "<company>/" prefix is routing metadata and must be stripped.
    expect(req.body.model).toBe("gpt-5");
    expect(req.body.messages).toEqual(USER);
    expect(req.body.temperature).toBe(0.3);
    expect(req.body.max_tokens).toBe(256);
    expect(req.body.stream).toBe(false);

    expect(result).toEqual({
      text: "hello",
      model: "gpt-5",
      usage: { inputTokens: 10, outputTokens: 4 },
      finishReason: "stop",
    });
  });

  it("routes each compatible provider to its own base URL", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);
    await provider().generate({ model: "deepseek/deepseek-chat", messages: USER });
    expect(fetchMock.one.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(fetchMock.one.headers["authorization"]).toBe("Bearer sk-ds");
  });

  it("omits sampling params the caller did not set", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);
    await provider().generate({ model: "openai/gpt-5", messages: USER });
    expect(fetchMock.one.body).not.toHaveProperty("temperature");
    expect(fetchMock.one.body).not.toHaveProperty("max_tokens");
  });

  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["tool_calls", "stop"],
    [null, "stop"],
  ])("maps finish_reason %s to %s", async (raw, expected) => {
    mockFetch([jsonResponse({ choices: [{ message: { content: "" }, finish_reason: raw }] })]);
    const result = await provider().generate({ model: "openai/gpt-5", messages: USER });
    expect(result.finishReason).toBe(expected);
  });

  it("tolerates a missing content/usage without throwing", async () => {
    mockFetch([jsonResponse({ choices: [{ message: { content: null } }] })]);
    const result = await provider().generate({ model: "openai/gpt-5", messages: USER });
    expect(result.text).toBe("");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("OpenAI-compatible: stream", () => {
  it("streams deltas and ends with usage", async () => {
    const fetchMock = mockFetch([
      sseResponse([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
        "[DONE]",
      ]),
    ]);

    const { text, deltas, usage } = await collectStream(
      provider().stream({ model: "openai/gpt-5", messages: USER }),
    );

    expect(text).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(fetchMock.one.body.stream).toBe(true);
    expect(fetchMock.one.body.stream_options).toEqual({ include_usage: true });
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    mockFetch([
      sseResponse([{ choices: [{ delta: { content: "a" } }] }, "[DONE]", { choices: [{ delta: { content: "ZZZ" } }] }]),
    ]);
    const { text } = await collectStream(provider().stream({ model: "openai/gpt-5", messages: USER }));
    expect(text).toBe("a");
  });

  it("skips non-JSON keep-alive events", async () => {
    mockFetch([sseResponse(["ping", { choices: [{ delta: { content: "ok" } }] }, "[DONE]"])]);
    const { text } = await collectStream(provider().stream({ model: "openai/gpt-5", messages: USER }));
    expect(text).toBe("ok");
  });
});

describe("Anthropic: generate", () => {
  it("posts /messages with system hoisted and x-api-key auth", async () => {
    const fetchMock = mockFetch([
      jsonResponse({
        model: "claude-opus-4.8",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
    ]);

    const result = await provider().generate({
      model: "anthropic/claude-opus-4.8",
      messages: WITH_SYSTEM,
    });

    const req = fetchMock.one;
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant");
    expect(req.headers["anthropic-version"]).toBeTruthy();
    expect(req.headers).not.toHaveProperty("authorization");

    // System is a top-level field, never an inline message.
    expect(req.body.system).toBe("be brief");
    expect(req.body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
    expect(result.text).toBe("hi there");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  // Anthropic rejects the request outright without max_tokens.
  it("always sends max_tokens, defaulting when the caller omits it", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({ model: "anthropic/claude-opus-4.8", messages: USER });
    expect(fetchMock.one.body.max_tokens).toBe(1024);
  });

  it("respects an explicit maxTokens", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({
      model: "anthropic/claude-opus-4.8",
      messages: USER,
      maxTokens: 77,
    });
    expect(fetchMock.one.body.max_tokens).toBe(77);
  });

  it("omits system entirely when there is no system message", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({ model: "anthropic/claude-opus-4.8", messages: USER });
    expect(fetchMock.one.body).not.toHaveProperty("system");
  });

  it("merges multiple system messages", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({
      model: "anthropic/claude-opus-4.8",
      messages: [
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "hi" },
      ],
    });
    expect(fetchMock.one.body.system).toBe("one\n\ntwo");
  });

  it("concatenates text blocks and ignores non-text blocks", async () => {
    mockFetch([
      jsonResponse({
        content: [
          { type: "text", text: "a" },
          { type: "tool_use", id: "t1" },
          { type: "text", text: "b" },
        ],
      }),
    ]);
    const result = await provider().generate({
      model: "anthropic/claude-opus-4.8",
      messages: USER,
    });
    expect(result.text).toBe("ab");
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    [null, "stop"],
  ])("maps stop_reason %s to %s", async (raw, expected) => {
    mockFetch([jsonResponse({ content: [], stop_reason: raw })]);
    const result = await provider().generate({
      model: "anthropic/claude-opus-4.8",
      messages: USER,
    });
    expect(result.finishReason).toBe(expected);
  });
});

describe("Anthropic: stream", () => {
  it("assembles text deltas and reports usage from both ends of the stream", async () => {
    mockFetch([
      sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 9 } } },
        { type: "content_block_start", index: 0 },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", usage: { output_tokens: 6 } },
        { type: "message_stop" },
      ]),
    ]);

    const { text, deltas, usage } = await collectStream(
      provider().stream({ model: "anthropic/claude-opus-4.8", messages: USER }),
    );

    expect(text).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    // input_tokens arrives in message_start, output_tokens in message_delta.
    expect(usage).toEqual({ inputTokens: 9, outputTokens: 6 });
  });
});

describe("Gemini: generate", () => {
  it("posts :generateContent with contents, systemInstruction and goog auth", async () => {
    const fetchMock = mockFetch([
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
      }),
    ]);

    const result = await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: WITH_SYSTEM,
      temperature: 0.5,
      maxTokens: 100,
    });

    const req = fetchMock.one;
    expect(req.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(req.headers["x-goog-api-key"]).toBe("g-key");
    expect(req.headers).not.toHaveProperty("authorization");

    // "assistant" must be renamed to "model"; system goes to systemInstruction.
    expect(req.body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "again" }] },
    ]);
    expect(req.body.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(req.body.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 100 });

    expect(result.text).toBe("hi");
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 2 });
  });

  it("joins multiple parts of a candidate", async () => {
    mockFetch([jsonResponse({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] })]);
    const result = await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: USER,
    });
    expect(result.text).toBe("ab");
  });

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["SAFETY", "content_filter"],
    ["RECITATION", "content_filter"],
    [undefined, "stop"],
  ])("maps finishReason %s to %s", async (raw, expected) => {
    mockFetch([jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: raw }] })]);
    const result = await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: USER,
    });
    expect(result.finishReason).toBe(expected);
  });
});

describe("Gemini: stream", () => {
  it("uses the SSE streaming endpoint and accumulates deltas", async () => {
    const fetchMock = mockFetch([
      sseResponse([
        { candidates: [{ content: { parts: [{ text: "Gem" }] } }] },
        {
          candidates: [{ content: { parts: [{ text: "ini" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
        },
      ]),
    ]);

    const { text, usage } = await collectStream(
      provider().stream({ model: "gemini/gemini-2.5-flash", messages: USER }),
    );

    expect(fetchMock.one.url).toContain(":streamGenerateContent?alt=sse");
    expect(text).toBe("Gemini");
    expect(usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });
});
