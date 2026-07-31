/**
 * Provider registry — the single source of truth for:
 *   - which model providers the SDK understands (ProviderName enum),
 *   - the API base URL for each (PROVIDER_BASE_URLS),
 *   - the "<company>/<model>" id format and how to parse it.
 */

import { NeoError } from "../core/errors.js";

/** Known model providers. The string values are the "<company>" prefix. */
export enum ProviderName {
  OpenAI = "openai",
  Anthropic = "anthropic",
  XAI = "xai",
  Gemini = "gemini",
  Mistral = "mistral",
  Alibaba = "alibaba",
  DeepSeek = "deepseek",
  Meta = "meta",
}

/**
 * A fully-qualified model id: "<company>/<model>",
 * e.g. "anthropic/claude-opus-4.8".
 *
 * This is a TEMPLATE-LITERAL TYPE, not just a string. The prefix must be one
 * of ProviderName's values, so an unknown company is a compile-time error:
 *
 *   const ok:  ProviderModelId = "anthropic/claude-opus-4.8"; // valid
 *   const bad: ProviderModelId = "foobar/whatever";           // Type error
 *
 * The model half is `${string}` — any non-empty model name is accepted at the
 * type level; unknown model names are caught at runtime by the provider, not
 * here, since each provider's model catalog changes constantly.
 */
export type ProviderModelId = `${ProviderName}/${string}`;

/**
 * Base URL per provider.
 *
 * NOTE: these providers do NOT share one wire format. OpenAI, xAI, Mistral,
 * DeepSeek, Alibaba (Qwen/DashScope) and Meta (Llama) expose OpenAI-compatible
 * endpoints; Anthropic and Gemini use their own request/response shapes and
 * auth headers. Verify each against current provider docs before shipping —
 * URLs and regional variants change.
 */
export const PROVIDER_BASE_URLS: Record<ProviderName, string> = {
  [ProviderName.OpenAI]: "https://api.openai.com/v1",
  [ProviderName.Anthropic]: "https://api.anthropic.com/v1",
  [ProviderName.XAI]: "https://api.x.ai/v1",
  // Native Gemini API; OpenAI-compat lives under ".../v1beta/openai".
  [ProviderName.Gemini]: "https://generativelanguage.googleapis.com/v1beta",
  [ProviderName.Mistral]: "https://api.mistral.ai/v1",
  // Alibaba DashScope (Qwen), international endpoint; China host differs.
  [ProviderName.Alibaba]: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  [ProviderName.DeepSeek]: "https://api.deepseek.com/v1",
  // Meta Llama API (OpenAI-compatible surface under /compat).
  [ProviderName.Meta]: "https://api.llama.com/compat/v1",
};

/**
 * Providers that speak the OpenAI Chat Completions wire format
 * (POST /chat/completions, Bearer auth). Anthropic and Gemini are deliberately
 * absent — they use their own request/response shapes and are handled separately.
 */
export const OPENAI_COMPATIBLE_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  ProviderName.OpenAI,
  ProviderName.XAI,
  ProviderName.Mistral,
  ProviderName.DeepSeek,
  ProviderName.Alibaba,
  ProviderName.Meta,
]);

/** Anthropic requires this header on every request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Auth headers for a provider. Most use `Authorization: Bearer`, but Anthropic
 * uses `x-api-key` (+ version) and Gemini uses `x-goog-api-key`.
 */
export function authHeaders(provider: ProviderName, apiKey: string): Record<string, string> {
  switch (provider) {
    case ProviderName.Anthropic:
      return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
    case ProviderName.Gemini:
      return { "x-goog-api-key": apiKey };
    default:
      return { authorization: `Bearer ${apiKey}` };
  }
}

export interface ParsedModelId {
  provider: ProviderName;
  /** The model name after the "/", e.g. "claude-opus-4.8". */
  model: string;
}

/** Valid prefixes, derived from the enum so this never drifts out of sync. */
const KNOWN_PROVIDERS = new Set<string>(Object.values(ProviderName));

/**
 * Split a "<company>/<model>" id into its parts.
 *
 * The ProviderModelId type already blocks unknown prefixes at compile time.
 * This runtime check is the backstop for cases where the type was bypassed —
 * a value read from config, an `as` cast, or a plain `string` at the boundary.
 */
export function parseModelId(id: ProviderModelId): ParsedModelId {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new NeoError(
      `Invalid model id "${id}". Expected "<company>/<model>", e.g. "anthropic/claude-opus-4.8".`,
    );
  }

  const prefix = id.slice(0, slash);
  const model = id.slice(slash + 1);

  if (!KNOWN_PROVIDERS.has(prefix)) {
    throw new NeoError(
      `Unknown provider "${prefix}". Known providers: ${[...KNOWN_PROVIDERS].join(", ")}.`,
    );
  }

  return { provider: prefix as ProviderName, model };
}
