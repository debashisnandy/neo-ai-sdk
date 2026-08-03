/**
 * Tool-calling tests: the request shape for declaring tools, the response shape
 * for receiving calls, and the round-trip of feeding results back — for all
 * three wire formats.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { UnifiedProvider } from "../src/providers/unified.js";
import { ToolCallAccumulator, parseToolArguments } from "../src/providers/shared.js";
import { NeoError } from "../src/core/errors.js";
import type { Message, Tool } from "../src/core/types.js";
import { collectStream, jsonResponse, mockFetch, sseResponse } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const provider = () =>
  new UnifiedProvider({ apiKeys: { openai: "k", anthropic: "k", gemini: "k" } });

const WEATHER: Tool = {
  name: "get_weather",
  description: "Look up the weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const ASK: Message[] = [{ role: "user", content: "weather in Oslo?" }];

/** A conversation that already contains a call and its result. */
const ROUND_TRIP: Message[] = [
  { role: "user", content: "weather in Oslo?" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_abc", name: "get_weather", arguments: { city: "Oslo" } }],
  },
  { role: "tool", toolCallId: "call_abc", content: '{"tempC":3}' },
];

describe("parseToolArguments", () => {
  it("parses a JSON object", () => {
    expect(parseToolArguments("t", '{"a":1}')).toEqual({ a: 1 });
  });

  it("treats empty arguments as an empty object", () => {
    expect(parseToolArguments("t", "")).toEqual({});
    expect(parseToolArguments("t", "   ")).toEqual({});
  });

  // Defaulting to {} would silently run the tool with wrong arguments.
  it("throws on malformed JSON, naming the tool", () => {
    expect(() => parseToolArguments("get_weather", '{"city":')).toThrow(NeoError);
    expect(() => parseToolArguments("get_weather", '{"city":')).toThrow(/get_weather/);
  });

  it("throws when arguments are not an object", () => {
    expect(() => parseToolArguments("t", "[1,2]")).toThrow(NeoError);
    expect(() => parseToolArguments("t", '"hi"')).toThrow(NeoError);
    expect(() => parseToolArguments("t", "null")).toThrow(NeoError);
  });
});

describe("ToolCallAccumulator", () => {
  it("assembles fragments into complete calls, ordered by index", () => {
    const acc = new ToolCallAccumulator();
    acc.open(1, "id1", "second");
    acc.open(0, "id0", "first");
    acc.push(0, '{"a"');
    acc.push(1, '{"b":2}');
    acc.push(0, ":1}");

    expect(acc.finish()).toEqual([
      { id: "id0", name: "first", arguments: { a: 1 } },
      { id: "id1", name: "second", arguments: { b: 2 } },
    ]);
  });

  it("keeps the first non-empty id/name when an index reopens", () => {
    const acc = new ToolCallAccumulator();
    acc.open(0, "id0", "tool");
    acc.open(0, "", "");
    acc.push(0, "{}");
    expect(acc.finish()).toEqual([{ id: "id0", name: "tool", arguments: {} }]);
  });

  it("reports how many calls it holds", () => {
    const acc = new ToolCallAccumulator();
    expect(acc.size).toBe(0);
    acc.open(0, "a", "t");
    expect(acc.size).toBe(1);
  });
});

describe("OpenAI-compatible tools", () => {
  it("declares tools and tool_choice in the request", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);
    await provider().generate({
      model: "openai/gpt-5",
      messages: ASK,
      tools: [WEATHER],
      toolChoice: "required",
    });

    expect(fetchMock.one.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up the weather",
          parameters: WEATHER.parameters,
        },
      },
    ]);
    expect(fetchMock.one.body.tool_choice).toBe("required");
  });

  it("maps a named tool_choice to OpenAI's object form", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);
    await provider().generate({
      model: "openai/gpt-5",
      messages: ASK,
      tools: [WEATHER],
      toolChoice: { name: "get_weather" },
    });
    expect(fetchMock.one.body.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it("omits tool fields entirely when no tools are given", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);
    await provider().generate({ model: "openai/gpt-5", messages: ASK, toolChoice: "auto" });
    expect(fetchMock.one.body).not.toHaveProperty("tools");
    expect(fetchMock.one.body).not.toHaveProperty("tool_choice");
  });

  it("parses returned tool calls and reports tool_use", async () => {
    mockFetch([
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const result = await provider().generate({
      model: "openai/gpt-5",
      messages: ASK,
      tools: [WEATHER],
    });

    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", arguments: { city: "Oslo" } },
    ]);
    expect(result.finishReason).toBe("tool_use");
    expect(result.text).toBe("");
  });

  // Some OpenAI-compatible providers report "stop" even when calling tools.
  it("infers tool_use when calls are present but finish_reason says stop", async () => {
    mockFetch([
      jsonResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: "{}" } }],
            },
            finish_reason: "stop",
          },
        ],
      }),
    ]);
    const result = await provider().generate({ model: "openai/gpt-5", messages: ASK });
    expect(result.finishReason).toBe("tool_use");
  });

  it("sends assistant tool calls and tool results back in OpenAI shape", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "3C" } }] })]);
    await provider().generate({ model: "openai/gpt-5", messages: ROUND_TRIP, tools: [WEATHER] });

    expect(fetchMock.one.body.messages).toEqual([
      { role: "user", content: "weather in Oslo?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: '{"tempC":3}' },
    ]);
  });

  it("accumulates streamed tool-call fragments into one complete call", async () => {
    mockFetch([
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
        "[DONE]",
      ]),
    ]);

    const chunks: Array<{ delta: string; toolCalls?: unknown }> = [];
    for await (const chunk of provider().stream({
      model: "openai/gpt-5",
      messages: ASK,
      tools: [WEATHER],
    })) {
      chunks.push(chunk);
    }

    // Partial JSON must never surface; only the finished call does.
    const final = chunks.at(-1)!;
    expect(final.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", arguments: { city: "Oslo" } },
    ]);
    expect(chunks.filter((c) => c.toolCalls)).toHaveLength(1);
  });

  it("streams two parallel tool calls independently", async () => {
    mockFetch([
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "a", function: { name: "one", arguments: '{"x":1}' } },
                  { index: 1, id: "b", function: { name: "two", arguments: '{"y":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "2}" } }] } }] },
        "[DONE]",
      ]),
    ]);

    const { toolCalls } = await collectStream(
      provider().stream({ model: "openai/gpt-5", messages: ASK, tools: [WEATHER] }),
    );
    expect(toolCalls).toEqual([
      { id: "a", name: "one", arguments: { x: 1 } },
      { id: "b", name: "two", arguments: { y: 2 } },
    ]);
  });
});

describe("Anthropic tools", () => {
  it("declares tools with input_schema and maps tool_choice", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({
      model: "anthropic/claude-opus-5",
      messages: ASK,
      tools: [WEATHER],
      toolChoice: "required",
    });

    expect(fetchMock.one.body.tools).toEqual([
      {
        name: "get_weather",
        description: "Look up the weather",
        input_schema: WEATHER.parameters,
      },
    ]);
    // Anthropic spells "must call something" as {type:"any"}.
    expect(fetchMock.one.body.tool_choice).toEqual({ type: "any" });
  });

  it("maps a named tool_choice", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({
      model: "anthropic/claude-opus-5",
      messages: ASK,
      tools: [WEATHER],
      toolChoice: { name: "get_weather" },
    });
    expect(fetchMock.one.body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("reads tool_use blocks, whose input is already parsed", async () => {
    mockFetch([
      jsonResponse({
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Oslo" } },
        ],
        stop_reason: "tool_use",
      }),
    ]);

    const result = await provider().generate({
      model: "anthropic/claude-opus-5",
      messages: ASK,
      tools: [WEATHER],
    });

    expect(result.text).toBe("Let me check.");
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", name: "get_weather", arguments: { city: "Oslo" } },
    ]);
    expect(result.finishReason).toBe("tool_use");
  });

  it("sends tool results as a user turn with tool_result blocks", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({
      model: "anthropic/claude-opus-5",
      messages: ROUND_TRIP,
      tools: [WEATHER],
    });

    expect(fetchMock.one.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather in Oslo?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "Oslo" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_abc", content: '{"tempC":3}' }],
      },
    ]);
  });

  // Anthropic rejects consecutive user turns; parallel results must be merged.
  it("merges consecutive tool results into a single user message", async () => {
    const fetchMock = mockFetch([jsonResponse({ content: [] })]);
    await provider().generate({
      model: "anthropic/claude-opus-5",
      messages: [
        { role: "user", content: "two cities?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "get_weather", arguments: { city: "Oslo" } },
            { id: "c2", name: "get_weather", arguments: { city: "Rome" } },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "3" },
        { role: "tool", toolCallId: "c2", content: "18" },
      ],
    });

    const messages = fetchMock.one.body.messages;
    expect(messages).toHaveLength(3);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "3" },
      { type: "tool_result", tool_use_id: "c2", content: "18" },
    ]);
  });

  it("accumulates input_json_delta fragments while still streaming text", async () => {
    mockFetch([
      sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 4 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_9", name: "get_weather" },
        },
        { type: "content_block_delta", index: 1, delta: { partial_json: '{"city"' } },
        { type: "content_block_delta", index: 1, delta: { partial_json: ':"Oslo"}' } },
        { type: "message_delta", usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ]),
    ]);

    const { text, usage, toolCalls } = await collectStream(
      provider().stream({ model: "anthropic/claude-opus-5", messages: ASK, tools: [WEATHER] }),
    );

    expect(text).toBe("Checking");
    expect(usage).toEqual({ inputTokens: 4, outputTokens: 7 });
    expect(toolCalls).toEqual([
      { id: "toolu_9", name: "get_weather", arguments: { city: "Oslo" } },
    ]);
  });
});

describe("Gemini tools", () => {
  it("declares functionDeclarations and a toolConfig mode", async () => {
    const fetchMock = mockFetch([jsonResponse({ candidates: [] })]);
    await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: ASK,
      tools: [WEATHER],
      toolChoice: "required",
    });

    expect(fetchMock.one.body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Look up the weather",
            parameters: WEATHER.parameters,
          },
        ],
      },
    ]);
    expect(fetchMock.one.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  it("restricts to one function for a named tool_choice", async () => {
    const fetchMock = mockFetch([jsonResponse({ candidates: [] })]);
    await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: ASK,
      tools: [WEATHER],
      toolChoice: { name: "get_weather" },
    });
    expect(fetchMock.one.body.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
    });
  });

  it("synthesizes ids for functionCall parts, which Gemini does not provide", async () => {
    mockFetch([
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "checking " },
                { functionCall: { name: "get_weather", args: { city: "Oslo" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    ]);

    const result = await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: ASK,
      tools: [WEATHER],
    });

    expect(result.toolCalls).toEqual([
      { id: "call_0", name: "get_weather", arguments: { city: "Oslo" } },
    ]);
    // Gemini reports STOP even for a function call; we normalize to tool_use.
    expect(result.finishReason).toBe("tool_use");
    expect(result.text).toBe("checking ");
  });

  it("resolves a tool result's id back to the function name", async () => {
    const fetchMock = mockFetch([jsonResponse({ candidates: [] })]);
    await provider().generate({ model: "gemini/gemini-2.5-flash", messages: ROUND_TRIP });

    expect(fetchMock.one.body.contents).toEqual([
      { role: "user", parts: [{ text: "weather in Oslo?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }] },
      // Matched by NAME, not id — the id only exists in this SDK.
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", response: { tempC: 3 } } }],
      },
    ]);
  });

  it("wraps a non-JSON tool result in an object", async () => {
    const fetchMock = mockFetch([jsonResponse({ candidates: [] })]);
    await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "get_weather", arguments: {} }],
        },
        { role: "tool", toolCallId: "c1", content: "cold" },
      ],
    });

    const parts = fetchMock.one.body.contents[1].parts;
    expect(parts[0].functionResponse.response).toEqual({ result: "cold" });
  });

  it("collects streamed function calls", async () => {
    mockFetch([
      sseResponse([
        { candidates: [{ content: { parts: [{ text: "ok " }] } }] },
        {
          candidates: [
            { content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }] } },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
        },
      ]),
    ]);

    const { text, toolCalls } = await collectStream(
      provider().stream({ model: "gemini/gemini-2.5-flash", messages: ASK, tools: [WEATHER] }),
    );

    expect(text).toBe("ok ");
    expect(toolCalls).toEqual([{ id: "call_0", name: "get_weather", arguments: { city: "Oslo" } }]);
  });
});

describe("cross-provider consistency", () => {
  // The whole point of the SDK: identical caller code regardless of backend.
  it("returns the same normalized shape from every provider", async () => {
    const cases = [
      [
        "openai/gpt-5",
        jsonResponse({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "x", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ],
      [
        "anthropic/claude-opus-5",
        jsonResponse({
          content: [{ type: "tool_use", id: "x", name: "get_weather", input: { city: "Oslo" } }],
          stop_reason: "tool_use",
        }),
      ],
      [
        "gemini/gemini-2.5-flash",
        jsonResponse({
          candidates: [
            { content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }] } },
          ],
        }),
      ],
    ] as const;

    for (const [model, response] of cases) {
      mockFetch([response]);
      const result = await provider().generate({ model, messages: ASK, tools: [WEATHER] });

      expect(result.finishReason, model).toBe("tool_use");
      expect(result.toolCalls, model).toHaveLength(1);
      expect(result.toolCalls[0]!.name, model).toBe("get_weather");
      expect(result.toolCalls[0]!.arguments, model).toEqual({ city: "Oslo" });
      vi.unstubAllGlobals();
    }
  });
});

