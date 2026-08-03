/**
 * neo-ai-sdk — public API surface.
 *
 * Everything a consumer can import from "neo-ai-sdk" is re-exported here.
 * Keep this file as a barrel only: no logic lives here, so the published
 * type surface stays easy to review and tree-shaking stays effective.
 */

// --- Client ---------------------------------------------------------------
export { NeoClient } from "./client.js";
export type { NeoClientOptions } from "./client.js";

// --- Config ---------------------------------------------------------------
export { apiKeysFromEnv } from "./config.js";

// --- Public types ---------------------------------------------------------
export type {
  Message,
  Role,
  GenerateParams,
  GenerateResult,
  StreamChunk,
  Usage,
  Tool,
  ToolCall,
  ToolChoice,
  JSONSchema,
  OrchestrateOptions,
  OrchestrationTrace,
  SubtaskResult,
} from "./core/types.js";

// --- Orchestration (advanced) --------------------------------------------
export { WorkerPool } from "./orchestrator/worker-pool.js";
export type { WorkerPoolOptions } from "./orchestrator/worker-pool.js";

// --- Errors ---------------------------------------------------------------
export {
  NeoError,
  APIError,
  AuthenticationError,
  RateLimitError,
  TimeoutError,
} from "./core/errors.js";

// --- Providers (advanced: bring-your-own or configure a built-in) ---------
export type { Provider } from "./providers/provider.js";

// Unified provider: address any backend as "<company>/<model>".
export { UnifiedProvider } from "./providers/unified.js";
export type { UnifiedProviderOptions, UnifiedGenerateParams } from "./providers/unified.js";
export { ProviderName, PROVIDER_BASE_URLS, parseModelId } from "./providers/registry.js";
export type { ProviderModelId, ParsedModelId } from "./providers/registry.js";

// --- Structured output ----------------------------------------------------
export { fromSchema } from "./core/output.js";
export type {
  OutputSchema,
  OutputSpec,
  InferOutput,
  StandardSchemaV1,
} from "./core/output.js";
