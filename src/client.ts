/**
 * NeoClient — the top-level entry point consumers instantiate.
 *
 *   const neo = new NeoClient({ apiKeys: { openai: "..." } });
 *   const res = await neo.generate({ model: "openai/gpt-5", messages });
 *
 * By default it drives the UnifiedProvider, so any registered provider is
 * addressable as "<company>/<model>". Pass `provider` to swap in your own.
 */

import { apiKeysFromEnv } from "./config.js";
import {
  UnifiedProvider,
  type UnifiedProviderOptions,
  type UnifiedGenerateParams,
} from "./providers/unified.js";
import type { Provider } from "./providers/provider.js";
import type { GenerateResult, StreamChunk } from "./core/types.js";

export interface NeoClientOptions extends Partial<UnifiedProviderOptions> {
  /** Override the default UnifiedProvider, e.g. to plug in a custom Provider. */
  provider?: Provider;
}

export class NeoClient {
  private readonly provider: Provider;

  constructor(options: NeoClientOptions) {
    if (options.provider) {
      this.provider = options.provider;
      return;
    }

    // Explicit keys win over environment-derived ones.
    const apiKeys = { ...apiKeysFromEnv(), ...(options.apiKeys ?? {}) };
    this.provider = new UnifiedProvider({ ...options, apiKeys });
  }

  /** One-shot text generation. Model is "<company>/<model>". */
  generate(params: UnifiedGenerateParams): Promise<GenerateResult> {
    return this.provider.generate(params);
  }

  /** Streaming text generation; `for await (const chunk of neo.stream(...))`. */
  stream(params: UnifiedGenerateParams): AsyncIterable<StreamChunk> {
    return this.provider.stream(params);
  }
}
