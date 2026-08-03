/**
 * Applies memory around a model call: recall before, persist after.
 *
 * Both steps are best-effort by default. A memory backend being unreachable
 * degrades answer quality; it should not take the application down. Set
 * `strict: true` to make store failures fatal instead.
 */

import { NeoError } from "../core/errors.js";
import type { GenerateResult, Message } from "../core/types.js";
import {
  defaultCapture,
  defaultFormat,
  defaultQuery,
  type MemoryOptions,
  type MemorySpec,
  type MemoryStore,
} from "./types.js";
import { MEM0_ENV_VAR, mem0Store, type Mem0StoreOptions } from "./mem0.js";

/** Normalize the `memory` param: `true` is shorthand for `{ mem0: true }`. */
function normalize(spec: MemorySpec | undefined): MemoryOptions | undefined {
  if (spec === undefined || spec === false) return undefined;
  if (spec === true) return { mem0: true };
  return spec;
}

/**
 * Merge client-level and per-request memory settings. Per-request wins field by
 * field, so a call usually only needs to supply `userId`.
 */
export function combineMemory(
  base: MemorySpec | undefined,
  extra: MemorySpec | undefined,
): MemoryOptions | undefined {
  // An explicit `memory: false` on a request switches memory off entirely.
  if (extra === false) return undefined;

  const a = normalize(base);
  const b = normalize(extra);
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b };
}

/**
 * Cache of mem0 stores, keyed by their resolved configuration.
 *
 * Keying on the options object would never hit: combineMemory builds a fresh
 * object for every call, so each request would construct a new Transport.
 * The config itself is stable, so that is what identifies a store. Distinct
 * configurations are few (usually one), so this stays small.
 */
const mem0Cache = new Map<string, MemoryStore>();

function mem0CacheKey(config: Mem0StoreOptions): string {
  // The API key participates so two tenants never share a store.
  return JSON.stringify([
    config.apiKey ?? process.env[MEM0_ENV_VAR] ?? "",
    config.baseURL ?? "",
    config.addPath ?? "",
    config.searchPath ?? "",
    config.orgId ?? "",
    config.projectId ?? "",
    config.timeoutMs ?? "",
    config.maxRetries ?? "",
  ]);
}

/** Resolve the backend, building a mem0 store on demand. */
function requireStore(options: MemoryOptions): MemoryStore {
  if (options.store) return options.store;

  if (options.mem0) {
    const config = typeof options.mem0 === "object" ? options.mem0 : {};
    const key = mem0CacheKey(config);

    const cached = mem0Cache.get(key);
    if (cached) return cached;

    const store = mem0Store(config);
    mem0Cache.set(key, store);
    return store;
  }

  throw new NeoError(
    "Memory is enabled but no backend was configured. Use `memory: true` with " +
      `${MEM0_ENV_VAR} set, or pass your own \`memory: { store }\`.`,
  );
}

function report(options: MemoryOptions, error: unknown, stage: "recall" | "persist"): void {
  options.onError?.(error, stage);
  if (options.strict) throw error;
}

/**
 * Recall relevant memories and prepend them as a system message.
 *
 * Injecting as `system` rather than editing the user's text keeps the caller's
 * messages intact and lets providers treat it as instruction context.
 */
export async function recallInto(
  options: MemoryOptions,
  messages: Message[],
): Promise<Message[]> {
  if (options.recall === false) return messages;

  const query = (options.query ?? defaultQuery)(messages);
  if (!query) return messages; // nothing to search on

  try {
    const store = requireStore(options);
    const memories = await store.search(query, {
      userId: options.userId,
      agentId: options.agentId,
      runId: options.runId,
      metadata: options.metadata,
      limit: options.limit ?? 5,
    });
    if (memories.length === 0) return messages;

    const content = (options.format ?? defaultFormat)(memories);
    if (!content) return messages;

    return [{ role: "system", content }, ...messages];
  } catch (err) {
    report(options, err, "recall");
    return messages; // proceed without memory
  }
}

/** Persist the exchange. Never changes the result. */
export async function persistFrom(
  options: MemoryOptions,
  messages: Message[],
  result: GenerateResult,
): Promise<void> {
  if (options.persist === false) return;

  try {
    const store = requireStore(options);
    const captured = (options.capture ?? defaultCapture)(messages, result);
    if (captured.length === 0) return;

    await store.add(captured, {
      userId: options.userId,
      agentId: options.agentId,
      runId: options.runId,
      metadata: options.metadata,
    });
  } catch (err) {
    report(options, err, "persist");
  }
}
