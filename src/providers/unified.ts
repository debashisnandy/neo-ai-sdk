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
import {
  combineGuardrails,
  runInputGuardrails,
  runOutputGuardrails,
  runToolCallGuardrails,
} from "../guardrails/runner.js";
import type { Guardrail } from "../guardrails/types.js";
import { combineMemory, persistFrom, recallInto } from "../memory/runner.js";
import type { MemorySpec } from "../memory/types.js";
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
  /** Guardrails applied to every call. Per-request guardrails run after these. */
  guardrails?: readonly Guardrail[];
  /**
   * Long-term memory. `true` enables mem0 from MEM0_API_KEY; an object
   * configures it. Per-request `memory` overrides these fields.
   */
  memory?: MemorySpec;
}

/** GenerateParams pinned to the strict "<company>/<model>" id type. */
export type UnifiedGenerateParams = GenerateParams<ProviderModelId>;

export class UnifiedProvider implements Provider {
  readonly name = "unified";

  /** One Transport per provider, built on first use and reused after. */
  private readonly transports = new Map<ProviderName, Transport>();

  constructor(private readonly options: UnifiedProviderOptions) {}

  async generate(params: UnifiedGenerateParams): Promise<GenerateResult> {
    // Anthropic implements structured output by commandeering the tool slot,
    // so the two cannot coexist. Rejecting everywhere keeps behavior identical
    // across providers instead of working on some and not others.
    if (params.output && params.tools?.length) {
      throw new NeoError(
        "`output` and `tools` cannot be used together. Run structured output as " +
          "a separate call, or model the structure as a tool and read toolCalls.",
      );
    }

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

  /**
   * A single, non-orchestrated generate call.
   *
   * Order is deliberate:
   *   input guardrails → memory recall → provider → tool-call guardrails
   *   → output guardrails → memory persist
   *
   * Guardrails bracket memory on both sides, so a redaction guardrail scrubs
   * text before it is stored — memory never ends up holding the secrets that
   * redaction exists to remove.
   */
  private async generateOnce(params: UnifiedGenerateParams): Promise<GenerateResult> {
    const guardrails = combineGuardrails(this.options.guardrails, params.guardrails);
    const memory = combineMemory(this.options.memory, params.memory);

    if (guardrails.length === 0 && !memory) return this.rawGenerate(params);

    let messages = guardrails.length
      ? await runInputGuardrails(guardrails, params.model, params.messages, params)
      : params.messages;

    // Keep the guarded messages for persistence; recall only augments the
    // prompt and should not be written back into memory.
    const guarded = messages;
    if (memory) messages = await recallInto(memory, messages);

    const raw = await this.rawGenerate({ ...params, messages });

    // Inspect tool calls before the caller can act on them — that is the whole
    // point of blocking a dangerous call.
    const toolCalls = guardrails.length
      ? await runToolCallGuardrails(guardrails, params.model, raw.toolCalls, params)
      : raw.toolCalls;

    const result = guardrails.length
      ? await runOutputGuardrails(guardrails, params.model, { ...raw, toolCalls }, params)
      : { ...raw, toolCalls };

    if (memory) await persistFrom(memory, guarded, result);
    return result;
  }

  /** The provider call itself, with no guardrails applied. */
  private async rawGenerate(params: UnifiedGenerateParams): Promise<GenerateResult> {
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

  /**
   * Streaming applies input and tool-call guardrails.
   *
   * Output guardrails are skipped: text is emitted incrementally, so there is
   * no complete response to validate or redact before the caller has already
   * seen it. Use generate() when output guardrails must hold.
   */
  async *stream(params: UnifiedGenerateParams): AsyncIterable<StreamChunk> {
    const guardrails = combineGuardrails(this.options.guardrails, params.guardrails);

    const messages = guardrails.length
      ? await runInputGuardrails(guardrails, params.model, params.messages, params)
      : params.messages;

    for await (const chunk of this.rawStream({ ...params, messages })) {
      // Tool calls arrive complete in a single chunk, so they can still be
      // inspected before the caller acts on them.
      if (chunk.toolCalls?.length && guardrails.length) {
        const checked = await runToolCallGuardrails(
          guardrails,
          params.model,
          chunk.toolCalls,
          params,
        );
        yield { ...chunk, toolCalls: checked };
        continue;
      }
      yield chunk;
    }
  }

  private async *rawStream(params: UnifiedGenerateParams): AsyncIterable<StreamChunk> {
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
