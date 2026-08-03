/**
 * UnifiedProvider — one class that routes to any provider in the registry,
 * addressed by a "<company>/<model>" id like "anthropic/claude-opus-4.8".
 *
 * It parses the id, looks up the provider's base URL, picks the matching API
 * key, and lazily builds one Transport per provider. Turning a request into a
 * provider's specific wire format is the per-provider TODO in generate()/stream().
 */

import type { Provider } from "./provider.js";
import type { GenerateParams, GenerateResult, StreamChunk } from "../core/types.js";
import { Transport, type FetchLike } from "../core/http.js";
import { NeoError } from "../core/errors.js";
import { WorkerPool } from "../orchestrator/worker-pool.js";
import { orchestrate, type ResolvedOrchestrateOptions } from "../orchestrator/orchestrator.js";
import {
  ProviderName,
  PROVIDER_BASE_URLS,
  OPENAI_COMPATIBLE_PROVIDERS,
  authHeaders,
  parseModelId,
  type ProviderModelId,
} from "./registry.js";
import { openAICompatibleGenerate, openAICompatibleStream } from "./openai-compatible.js";
import { anthropicGenerate, anthropicStream } from "./anthropic.js";
import { geminiGenerate, geminiStream } from "./gemini.js";

export interface UnifiedProviderOptions {
  /**
   * API key per provider. Only the providers you actually call need a key;
   * a missing key surfaces as a clear runtime error when that provider is used.
   */
  apiKeys: Partial<Record<ProviderName, string>>;
  /** Optional base-URL overrides: self-hosted, proxies, or regional endpoints. */
  baseURLs?: Partial<Record<ProviderName, string>>;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Override the function used for requests. Used internally to route
   * sub-agent traffic through worker threads; see WorkerPool.
   */
  fetchImpl?: FetchLike;
}

/** GenerateParams pinned to the strict "<company>/<model>" id type. */
export type UnifiedGenerateParams = GenerateParams<ProviderModelId>;

export class UnifiedProvider implements Provider {
  readonly name = "unified";

  /** One Transport per provider, built on first use and reused after. */
  private readonly transports = new Map<ProviderName, Transport>();

  constructor(private readonly options: UnifiedProviderOptions) {}

  async generate(params: UnifiedGenerateParams): Promise<GenerateResult> {
    const orchestration = resolveOrchestrate(params.orchestrate);
    if (orchestration) return this.runOrchestrated(params, orchestration);
    return this.generateOnce(params);
  }

  /** Plan → delegate → synthesize, optionally with sub-agents on worker threads. */
  private async runOrchestrated(
    params: UnifiedGenerateParams,
    options: ResolvedOrchestrateOptions,
  ): Promise<GenerateResult> {
    const run = (p: GenerateParams) => this.generateOnce(p as UnifiedGenerateParams);

    if (options.executor !== "worker") {
      return orchestrate(params, options, run);
    }

    // Sub-agents get their own provider whose transport posts requests to the
    // pool. The pool is torn down even if orchestration throws, so a failed
    // request can never leak threads.
    const pool = new WorkerPool({ size: options.workers ?? options.maxConcurrency });
    const workerProvider = new UnifiedProvider({ ...this.options, fetchImpl: pool.fetch });
    try {
      return await orchestrate(params, options, run, (p) =>
        workerProvider.generateOnce(p as UnifiedGenerateParams),
      );
    } finally {
      await pool.close();
    }
  }

  /** A single, non-orchestrated generate call. */
  private async generateOnce(params: UnifiedGenerateParams): Promise<GenerateResult> {
    const { provider, model, transport } = this.route(params.model);

    if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
      return openAICompatibleGenerate(transport, model, params);
    }
    if (provider === ProviderName.Anthropic) {
      return anthropicGenerate(transport, model, params);
    }
    if (provider === ProviderName.Gemini) {
      return geminiGenerate(transport, model, params);
    }

    throw new NeoError(`generate() is not implemented for provider "${provider}".`);
  }

  async *stream(params: UnifiedGenerateParams): AsyncIterable<StreamChunk> {
    const { provider, model, transport } = this.route(params.model);

    if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
      yield* openAICompatibleStream(transport, model, params);
      return;
    }
    if (provider === ProviderName.Anthropic) {
      yield* anthropicStream(transport, model, params);
      return;
    }
    if (provider === ProviderName.Gemini) {
      yield* geminiStream(transport, model, params);
      return;
    }

    throw new NeoError(`stream() is not implemented for provider "${provider}".`);
  }

  /** Parse "<company>/<model>" and resolve its provider, model name, and Transport. */
  private route(modelId: ProviderModelId): {
    provider: ProviderName;
    model: string;
    transport: Transport;
  } {
    const { provider, model } = parseModelId(modelId);
    return { provider, model, transport: this.transportFor(provider) };
  }

  /** Build (once) the Transport for a provider from its URL + key. */
  private transportFor(provider: ProviderName): Transport {
    const existing = this.transports.get(provider);
    if (existing) return existing;

    const apiKey = this.options.apiKeys[provider];
    if (!apiKey) {
      throw new NeoError(
        `No API key configured for provider "${provider}". ` +
          `Pass it via apiKeys: { ${provider}: "..." }.`,
      );
    }

    const baseURL = this.options.baseURLs?.[provider] ?? PROVIDER_BASE_URLS[provider];
    const transport = new Transport({
      baseURL,
      // Bearer for OpenAI-style providers, x-api-key for Anthropic,
      // x-goog-api-key for Gemini — see authHeaders() in the registry.
      headers: authHeaders(provider, apiKey),
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      fetchImpl: this.options.fetchImpl,
    });

    this.transports.set(provider, transport);
    return transport;
  }
}

/** Normalize the `orchestrate` param into full options, or undefined if off. */
function resolveOrchestrate(
  value: UnifiedGenerateParams["orchestrate"],
): ResolvedOrchestrateOptions | undefined {
  if (!value) return undefined;
  const opts = value === true ? {} : value;
  if (opts.enabled === false) return undefined;

  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4);
  return {
    executor: opts.executor ?? "inline",
    maxConcurrency,
    maxSubtasks: Math.max(1, opts.maxSubtasks ?? 5),
    workers: opts.workers ?? maxConcurrency,
    plannerModel: opts.plannerModel,
    agentModel: opts.agentModel,
  };
}
