import { afterEach, describe, expect, it, vi } from "vitest";
import { NeoClient } from "../src/client.js";
import { UnifiedProvider } from "../src/providers/unified.js";
import { apiKeysFromEnv } from "../src/config.js";
import { ProviderName } from "../src/providers/registry.js";
import { NeoError } from "../src/core/errors.js";
import type { Provider } from "../src/providers/provider.js";
import type { GenerateResult, StreamChunk } from "../src/core/types.js";
import { collectStream, jsonResponse, mockFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Records what it was asked for, so we can assert the client delegates verbatim. */
function fakeProvider() {
  const seen: unknown[] = [];
  const provider: Provider = {
    name: "fake",
    async generate(params): Promise<GenerateResult> {
      seen.push(params);
      return {
        text: "faked",
        model: params.model,
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      };
    },
    async *stream(params): AsyncIterable<StreamChunk> {
      seen.push(params);
      yield { delta: "fa" };
      yield { delta: "ked", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { provider, seen };
}

describe("NeoClient delegation", () => {
  it("uses an injected provider and passes params through untouched", async () => {
    const { provider, seen } = fakeProvider();
    const client = new NeoClient({ provider });

    const params = { model: "openai/gpt-5", messages: [{ role: "user" as const, content: "hi" }] };
    const result = await client.generate(params);

    expect(result.text).toBe("faked");
    expect(seen[0]).toEqual(params);
  });

  it("delegates streaming to the injected provider", async () => {
    const { provider } = fakeProvider();
    const client = new NeoClient({ provider });

    const { text, usage } = await collectStream(
      client.stream({ model: "openai/gpt-5", messages: [] }),
    );
    expect(text).toBe("faked");
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it("ignores API keys when a custom provider is supplied", async () => {
    const { provider } = fakeProvider();
    // No keys at all — must not throw, because the custom provider owns auth.
    const client = new NeoClient({ provider, apiKeys: {} });
    await expect(client.generate({ model: "openai/gpt-5", messages: [] })).resolves.toBeDefined();
  });
});

describe("NeoClient key resolution", () => {
  it("reads keys from the environment by default", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-from-env");
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);

    await new NeoClient({}).generate({ model: "openai/gpt-5", messages: [] });
    expect(fetchMock.one.headers["authorization"]).toBe("Bearer sk-from-env");
  });

  it("lets an explicit key win over the environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-from-env");
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);

    await new NeoClient({ apiKeys: { openai: "sk-explicit" } }).generate({
      model: "openai/gpt-5",
      messages: [],
    });
    expect(fetchMock.one.headers["authorization"]).toBe("Bearer sk-explicit");
  });

  it("throws a helpful error naming the provider when its key is missing", async () => {
    const client = new NeoClient({ apiKeys: { openai: "sk-1" } });
    const promise = client.generate({ model: "mistral/mistral-large", messages: [] });
    await expect(promise).rejects.toBeInstanceOf(NeoError);
    await expect(promise).rejects.toThrow(/mistral/);
  });
});

describe("apiKeysFromEnv", () => {
  it("maps each provider to its conventional env var", () => {
    const keys = apiKeysFromEnv({
      OPENAI_API_KEY: "a",
      ANTHROPIC_API_KEY: "b",
      XAI_API_KEY: "c",
      GEMINI_API_KEY: "d",
      MISTRAL_API_KEY: "e",
      DASHSCOPE_API_KEY: "f",
      DEEPSEEK_API_KEY: "g",
      LLAMA_API_KEY: "h",
    });

    expect(keys).toEqual({
      openai: "a",
      anthropic: "b",
      xai: "c",
      gemini: "d",
      mistral: "e",
      alibaba: "f",
      deepseek: "g",
      meta: "h",
    });
  });

  it("omits providers with no env var set", () => {
    expect(apiKeysFromEnv({ OPENAI_API_KEY: "a" })).toEqual({ openai: "a" });
  });

  it("ignores empty-string values rather than sending an empty key", () => {
    expect(apiKeysFromEnv({ OPENAI_API_KEY: "" })).toEqual({});
  });
});

describe("UnifiedProvider configuration", () => {
  it("honors a base URL override (proxy / self-hosted / regional)", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);
    const provider = new UnifiedProvider({
      apiKeys: { openai: "k" },
      baseURLs: { [ProviderName.OpenAI]: "https://proxy.internal/v1" },
    });

    await provider.generate({ model: "openai/gpt-5", messages: [] });
    expect(fetchMock.one.url).toBe("https://proxy.internal/v1/chat/completions");
  });

  it("passes maxRetries through to the transport", async () => {
    const fetchMock = mockFetch([
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    ]);
    const provider = new UnifiedProvider({ apiKeys: { openai: "k" }, maxRetries: 1 });

    await provider.generate({ model: "openai/gpt-5", messages: [] });
    expect(fetchMock.calls).toHaveLength(2);
  });

  it("serves several providers from one instance", async () => {
    const fetchMock = mockFetch([
      jsonResponse({ choices: [{ message: { content: "a" } }] }),
      jsonResponse({ content: [{ type: "text", text: "b" }] }),
    ]);
    const provider = new UnifiedProvider({ apiKeys: { openai: "k1", anthropic: "k2" } });

    await provider.generate({ model: "openai/gpt-5", messages: [] });
    await provider.generate({ model: "anthropic/claude-opus-4.8", messages: [] });

    expect(fetchMock.calls[0]!.headers["authorization"]).toBe("Bearer k1");
    expect(fetchMock.calls[1]!.headers["x-api-key"]).toBe("k2");
  });

  it("reuses one transport per provider across calls", async () => {
    const fetchMock = mockFetch([jsonResponse({ choices: [{ message: { content: "" } }] })]);
    const provider = new UnifiedProvider({ apiKeys: { openai: "k" } });

    await provider.generate({ model: "openai/gpt-5", messages: [] });
    await provider.generate({ model: "openai/gpt-5-mini", messages: [] });

    expect(fetchMock.calls).toHaveLength(2);
    expect(fetchMock.calls[0]!.headers).toEqual(fetchMock.calls[1]!.headers);
    expect(fetchMock.calls[1]!.body.model).toBe("gpt-5-mini");
  });
});
