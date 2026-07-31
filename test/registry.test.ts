import { describe, expect, it } from "vitest";
import {
  ProviderName,
  PROVIDER_BASE_URLS,
  OPENAI_COMPATIBLE_PROVIDERS,
  ANTHROPIC_VERSION,
  authHeaders,
  parseModelId,
} from "../src/providers/registry.js";
import { NeoError } from "../src/core/errors.js";

const ALL_PROVIDERS = Object.values(ProviderName);

describe("registry completeness", () => {
  it("covers all 8 advertised providers", () => {
    expect(ALL_PROVIDERS).toEqual([
      "openai",
      "anthropic",
      "xai",
      "gemini",
      "mistral",
      "alibaba",
      "deepseek",
      "meta",
    ]);
  });

  // Guards against adding an enum member but forgetting its URL.
  it("has a valid https base URL for every provider", () => {
    for (const provider of ALL_PROVIDERS) {
      const url = PROVIDER_BASE_URLS[provider];
      expect(url, `missing base URL for ${provider}`).toBeTruthy();
      expect(() => new URL(url)).not.toThrow();
      expect(url.startsWith("https://"), `${provider} must use https`).toBe(true);
      expect(url.endsWith("/"), `${provider} URL should not end in a slash`).toBe(false);
    }
  });

  it("routes every provider to exactly one wire format", () => {
    const nonCompatible = ALL_PROVIDERS.filter((p) => !OPENAI_COMPATIBLE_PROVIDERS.has(p));
    // Anthropic and Gemini are the only bespoke formats; everything else is
    // OpenAI-compatible. A new provider must be classified deliberately.
    expect(nonCompatible.sort()).toEqual([ProviderName.Anthropic, ProviderName.Gemini].sort());
  });
});

describe("parseModelId", () => {
  it("splits a well-formed id", () => {
    expect(parseModelId("anthropic/claude-opus-4.8")).toEqual({
      provider: ProviderName.Anthropic,
      model: "claude-opus-4.8",
    });
  });

  it("keeps slashes in the model half (org-scoped model names)", () => {
    // e.g. "meta/meta-llama/Llama-3.3-70B" — only the FIRST slash is the delimiter.
    expect(parseModelId("meta/meta-llama/Llama-3.3-70B")).toEqual({
      provider: ProviderName.Meta,
      model: "meta-llama/Llama-3.3-70B",
    });
  });

  it("parses every provider prefix", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(parseModelId(`${provider}/some-model`).provider).toBe(provider);
    }
  });

  // Runtime backstop: the ProviderModelId type blocks these at compile time,
  // but values from config or `as` casts bypass that.
  it.each([
    ["unknown provider", "foobar/model"],
    ["no slash", "anthropic"],
    ["empty model half", "anthropic/"],
    ["empty provider half", "/model"],
    ["empty string", ""],
  ])("rejects %s", (_label, id) => {
    expect(() => parseModelId(id as never)).toThrow(NeoError);
  });

  it("names the offending provider and the valid ones in the error", () => {
    expect(() => parseModelId("foobar/model" as never)).toThrow(/foobar/);
    expect(() => parseModelId("foobar/model" as never)).toThrow(/anthropic/);
  });
});

describe("authHeaders", () => {
  it("uses Bearer for OpenAI-compatible providers", () => {
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
      expect(authHeaders(provider, "sk-test")).toEqual({ authorization: "Bearer sk-test" });
    }
  });

  it("uses x-api-key + version for Anthropic", () => {
    expect(authHeaders(ProviderName.Anthropic, "sk-ant")).toEqual({
      "x-api-key": "sk-ant",
      "anthropic-version": ANTHROPIC_VERSION,
    });
  });

  it("uses x-goog-api-key for Gemini", () => {
    expect(authHeaders(ProviderName.Gemini, "g-key")).toEqual({ "x-goog-api-key": "g-key" });
  });

  // The key must never leak into a header that isn't the intended auth channel.
  it("never sends an Authorization header for Anthropic or Gemini", () => {
    for (const provider of [ProviderName.Anthropic, ProviderName.Gemini]) {
      expect(authHeaders(provider, "secret")).not.toHaveProperty("authorization");
    }
  });
});
