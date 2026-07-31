/**
 * Configuration helpers. With the unified multi-provider model, "config" is
 * mostly about collecting one API key per provider — here we resolve them from
 * the conventional environment variables.
 */

import { ProviderName } from "./providers/registry.js";

/** Standard environment variable name for each provider's API key. */
const ENV_VAR: Record<ProviderName, string> = {
  [ProviderName.OpenAI]: "OPENAI_API_KEY",
  [ProviderName.Anthropic]: "ANTHROPIC_API_KEY",
  [ProviderName.XAI]: "XAI_API_KEY",
  [ProviderName.Gemini]: "GEMINI_API_KEY",
  [ProviderName.Mistral]: "MISTRAL_API_KEY",
  [ProviderName.Alibaba]: "DASHSCOPE_API_KEY",
  [ProviderName.DeepSeek]: "DEEPSEEK_API_KEY",
  [ProviderName.Meta]: "LLAMA_API_KEY",
};

/**
 * Collect any provider API keys present in the environment. Providers whose
 * env var is unset are simply omitted, so the result can be merged under
 * explicitly-passed keys (which should win).
 */
export function apiKeysFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<Record<ProviderName, string>> {
  const keys: Partial<Record<ProviderName, string>> = {};
  for (const provider of Object.values(ProviderName)) {
    const value = env[ENV_VAR[provider]];
    if (value) keys[provider] = value;
  }
  return keys;
}
