/**
 * Structured output tests, using real Zod rather than a hand-rolled fake — the
 * point of the Standard Schema integration is that it works with a real
 * library, which only a real library can demonstrate.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UnifiedProvider } from "../src/providers/unified.js";
import { NeoClient } from "../src/client.js";
import { fromSchema, parseOutput, resolveOutput } from "../src/core/output.js";
import { NeoError } from "../src/core/errors.js";
import { jsonResponse, mockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const provider = () =>
  new UnifiedProvider({ apiKeys: { openai: "k", anthropic: "k", gemini: "k" } });

const Recipe = z.object({
  name: z.string(),
  minutes: z.number(),
  steps: z.array(z.string()),
});

const recipeOutput = fromSchema(Recipe, z.toJSONSchema(Recipe), { name: "recipe" });

const VALID = { name: "Toast", minutes: 3, steps: ["toast bread"] };
const ASK = [{ role: "user" as const, content: "Give me a recipe." }];

describe("fromSchema + Zod", () => {
  it("validates and returns the parsed value", () => {
    expect(recipeOutput.parse!(VALID)).toEqual(VALID);
  });

  it("throws a NeoError naming the failing field", () => {
    expect(() => recipeOutput.parse!({ name: "Toast", minutes: "three", steps: [] })).toThrow(
      NeoError,
    );
    expect(() => recipeOutput.parse!({ name: "Toast", minutes: "three", steps: [] })).toThrow(
      /minutes/,
    );
  });

  it("reports nested paths", () => {
    expect(() => recipeOutput.parse!({ name: "T", minutes: 1, steps: [42] })).toThrow(/steps\.0/);
  });

  it("applies Zod transforms, not just validation", () => {
    const Upper = z.object({ name: z.string().transform((s) => s.toUpperCase()) });
    // Zod refuses to render transforms as JSON Schema, so supply one by hand;
    // the point here is that `parse` runs the transform, not just validates.
    const out = fromSchema(Upper, {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(out.parse!({ name: "toast" })).toEqual({ name: "TOAST" });
  });

  it("rejects asynchronous validation with a clear error", () => {
    const Async = z.object({ n: z.string().refine(async () => true) });
    const out = fromSchema(Async, { type: "object" });
    expect(() => out.parse!({ n: "x" })).toThrow(/asynchronous/i);
  });
});

describe("resolveOutput", () => {
  it("passes a plain OutputSchema through untouched", () => {
    const spec = { name: "x", jsonSchema: { type: "object" } };
    expect(resolveOutput(spec)).toBe(spec);
  });

  // Zod 4 exposes toJSONSchema() on the schema itself, so a bare schema needs
  // no adapter at all.
  it("derives a JSON Schema from a bare Zod schema", () => {
    const resolved = resolveOutput(Recipe);
    expect(resolved.jsonSchema.properties).toHaveProperty("minutes");
    expect(resolved.parse!(VALID)).toEqual(VALID);
  });

  // Libraries that cannot self-convert must get guidance, not a silent
  // unconstrained request.
  it("explains how to supply a JSON Schema when none can be derived", () => {
    const bare = {
      "~standard": {
        version: 1 as const,
        vendor: "valibot",
        validate: (value: unknown) => ({ value }),
      },
    };
    expect(() => resolveOutput(bare)).toThrow(NeoError);
    expect(() => resolveOutput(bare)).toThrow(/fromSchema/);
    expect(() => resolveOutput(bare)).toThrow(/valibot/);
  });
});

describe("parseOutput", () => {
  const plain = { jsonSchema: { type: "object" } };

  it("parses JSON text", () => {
    expect(parseOutput(plain, '{"a":1}')).toEqual({ a: 1 });
  });

  it("throws on malformed JSON, showing what came back", () => {
    expect(() => parseOutput(plain, "{oops")).toThrow(/invalid JSON/);
    expect(() => parseOutput(plain, "{oops")).toThrow(/\{oops/);
  });

  it("throws on an empty response", () => {
    expect(() => parseOutput(plain, "   ")).toThrow(/empty/i);
  });
});

describe("OpenAI-compatible structured output", () => {
  it("sends response_format with the JSON schema and strict mode", async () => {
    const fetchMock = mockFetch([
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
    ]);

    await provider().generate({ model: "openai/gpt-5", messages: ASK, output: recipeOutput });

    const rf = fetchMock.one.body.response_format;
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("recipe");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema.properties).toHaveProperty("minutes");
  });

  it("returns the validated object alongside the raw text", async () => {
    mockFetch([jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID) } }] })]);

    const result = await provider().generate({
      model: "openai/gpt-5",
      messages: ASK,
      output: recipeOutput,
    });

    expect(result.object).toEqual(VALID);
    expect(JSON.parse(result.text)).toEqual(VALID);
  });

  it("throws when the model returns JSON that violates the schema", async () => {
    mockFetch([
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ name: "T", minutes: "lots", steps: [] }) } }],
      }),
    ]);

    await expect(
      provider().generate({ model: "openai/gpt-5", messages: ASK, output: recipeOutput }),
    ).rejects.toThrow(/minutes/);
  });

  it("omits response_format when no output is requested", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "hi" } }] })]);
    await provider().generate({ model: "openai/gpt-5", messages: ASK });
    expect(fetchMock.one.body).not.toHaveProperty("response_format");
  });
});

describe("Gemini structured output", () => {
  it("sets responseMimeType and responseSchema in generationConfig", async () => {
    const fetchMock = mockFetch([
      jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(VALID) }] } }],
      }),
    ]);

    const result = await provider().generate({
      model: "gemini/gemini-2.5-flash",
      messages: ASK,
      output: recipeOutput,
    });

    const cfg = fetchMock.one.body.generationConfig;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseSchema.properties).toHaveProperty("steps");
    expect(result.object).toEqual(VALID);
  });
});

describe("Anthropic structured output", () => {
  // Anthropic has no JSON mode; the schema becomes a single forced tool.
  it("declares the schema as a forced tool", async () => {
    const fetchMock = mockFetch([
      jsonResponse({
        content: [{ type: "tool_use", id: "t1", name: "recipe", input: VALID }],
        stop_reason: "tool_use",
      }),
    ]);

    await provider().generate({
      model: "anthropic/claude-opus-5",
      messages: ASK,
      output: recipeOutput,
    });

    const body = fetchMock.one.body;
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("recipe");
    expect(body.tools[0].input_schema.properties).toHaveProperty("minutes");
    expect(body.tool_choice).toEqual({ type: "tool", name: "recipe" });
  });

  it("returns the tool input as the object and hides the synthetic tool call", async () => {
    mockFetch([
      jsonResponse({
        content: [{ type: "tool_use", id: "t1", name: "recipe", input: VALID }],
        stop_reason: "tool_use",
      }),
    ]);

    const result = await provider().generate({
      model: "anthropic/claude-opus-5",
      messages: ASK,
      output: recipeOutput,
    });

    expect(result.object).toEqual(VALID);
    // The tool is an implementation detail — callers asked for an object.
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
    // text mirrors the object as JSON, matching the other providers.
    expect(JSON.parse(result.text)).toEqual(VALID);
  });

  it("throws when the model answers with prose instead of calling the tool", async () => {
    mockFetch([
      jsonResponse({ content: [{ type: "text", text: "here you go" }], stop_reason: "end_turn" }),
    ]);

    await expect(
      provider().generate({ model: "anthropic/claude-opus-5", messages: ASK, output: recipeOutput }),
    ).rejects.toThrow(/did not return structured output/);
  });

  it("validates the tool input against the schema", async () => {
    mockFetch([
      jsonResponse({
        content: [{ type: "tool_use", id: "t1", name: "recipe", input: { name: "T" } }],
        stop_reason: "tool_use",
      }),
    ]);

    await expect(
      provider().generate({ model: "anthropic/claude-opus-5", messages: ASK, output: recipeOutput }),
    ).rejects.toThrow(NeoError);
  });
});

describe("cross-provider consistency", () => {
  it("produces the same object from all three wire formats", async () => {
    const cases = [
      ["openai/gpt-5", jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID) } }] })],
      [
        "anthropic/claude-opus-5",
        jsonResponse({
          content: [{ type: "tool_use", id: "t", name: "recipe", input: VALID }],
          stop_reason: "tool_use",
        }),
      ],
      [
        "gemini/gemini-2.5-flash",
        jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID) }] } }] }),
      ],
    ] as const;

    for (const [model, response] of cases) {
      mockFetch([response]);
      const result = await provider().generate({ model, messages: ASK, output: recipeOutput });
      expect(result.object, model).toEqual(VALID);
      vi.unstubAllGlobals();
    }
  });
});

describe("passing a bare Zod schema", () => {
  it("works end to end with no adapter", async () => {
    const fetchMock = mockFetch([
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID) } }] }),
    ]);
    const client = new NeoClient({ apiKeys: { openai: "k" } });

    const result = await client.generate({
      model: "openai/gpt-5",
      messages: ASK,
      output: Recipe, // <- the Zod schema itself
    });

    // The schema still reaches the provider.
    expect(fetchMock.one.body.response_format.json_schema.schema.properties).toHaveProperty(
      "steps",
    );

    // result.object is typed as z.infer<typeof Recipe>, so these compile
    // without casts — that's the assertion as much as the runtime values.
    const minutes: number = result.object.minutes;
    const first: string | undefined = result.object.steps[0];
    expect(minutes).toBe(3);
    expect(first).toBe("toast bread");
  });
});

describe("output + tools guard", () => {
  it("rejects combining output with tools", async () => {
    const client = new NeoClient({ apiKeys: { openai: "k" } });
    await expect(
      client.generate({
        model: "openai/gpt-5",
        messages: ASK,
        output: recipeOutput,
        tools: [{ name: "t", parameters: { type: "object" } }],
      }),
    ).rejects.toThrow(/cannot be used together/);
  });
});
