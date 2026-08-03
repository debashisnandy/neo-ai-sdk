/**
 * mem0 support, built on the SDK's own Transport.
 *
 * Nothing is imported from `mem0ai` — the SDK speaks mem0's REST API directly,
 * the same way it speaks to the eight model providers. So mem0 needs no install
 * and no client object: set MEM0_API_KEY and turn it on.
 *
 *   const ai = new NeoClient({ apiKeys: {…}, memory: true });
 *
 * Endpoints and the `Token` auth scheme follow mem0's platform API. Both the
 * base URL and the paths are overridable, so a change on mem0's side can be
 * worked around without waiting for an SDK release.
 */

import { NeoError } from "../core/errors.js";
import { Transport } from "../core/http.js";
import type { Message } from "../core/types.js";
import type { MemoryRecord, MemoryScope, MemoryStore } from "./types.js";

export const MEM0_ENV_VAR = "MEM0_API_KEY";
const DEFAULT_BASE_URL = "https://api.mem0.ai";

export interface Mem0StoreOptions {
  /** Defaults to process.env.MEM0_API_KEY. */
  apiKey?: string;
  /** Defaults to https://api.mem0.ai — override for self-hosted deployments. */
  baseURL?: string;
  /** Path for storing memories. */
  addPath?: string;
  /** Path for searching. mem0 has shipped both v1 and v2 search. */
  searchPath?: string;
  /** Scope every call to an organization / project. */
  orgId?: string;
  projectId?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/** mem0 uses snake_case scoping keys; ours are camelCase. */
function toMem0Scope(scope: MemoryScope & { limit?: number }): Record<string, unknown> {
  return {
    ...(scope.userId !== undefined ? { user_id: scope.userId } : {}),
    ...(scope.agentId !== undefined ? { agent_id: scope.agentId } : {}),
    ...(scope.runId !== undefined ? { run_id: scope.runId } : {}),
    ...(scope.limit !== undefined ? { limit: scope.limit } : {}),
    ...(scope.metadata !== undefined ? { metadata: scope.metadata } : {}),
  };
}

/**
 * Normalize a mem0 search response.
 *
 * Shapes have differed across mem0 versions: some return a bare array, others
 * wrap it in `{ results: [...] }`, and the text field has been both `memory`
 * and `text`. Accepting all of them means a mem0-side change degrades to
 * "fewer memories", never a crash.
 */
function toRecords(response: unknown): MemoryRecord[] {
  const rows = Array.isArray(response)
    ? response
    : Array.isArray((response as { results?: unknown })?.results)
      ? (response as { results: unknown[] }).results
      : [];

  const records: MemoryRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const text =
      typeof r["memory"] === "string"
        ? r["memory"]
        : typeof r["text"] === "string"
          ? r["text"]
          : undefined;
    if (!text) continue;

    records.push({
      memory: text,
      ...(typeof r["id"] === "string" ? { id: r["id"] } : {}),
      ...(typeof r["score"] === "number" ? { score: r["score"] } : {}),
      ...(r["metadata"] && typeof r["metadata"] === "object"
        ? { metadata: r["metadata"] as Record<string, unknown> }
        : {}),
    });
  }
  return records;
}

/**
 * A MemoryStore backed by mem0's REST API.
 *
 * Throws if no API key is available — failing at construction is clearer than
 * silently storing nothing.
 */
export function mem0Store(options: Mem0StoreOptions = {}): MemoryStore {
  const apiKey = options.apiKey ?? process.env[MEM0_ENV_VAR];
  if (!apiKey) {
    throw new NeoError(
      `mem0 is enabled but no API key was found. Set ${MEM0_ENV_VAR}, or pass ` +
        `memory: { mem0: { apiKey: "..." } }.`,
    );
  }

  const transport = new Transport({
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    // mem0 uses the "Token" scheme rather than "Bearer".
    headers: {
      authorization: `Token ${apiKey}`,
      ...(options.orgId ? { "x-organization-id": options.orgId } : {}),
      ...(options.projectId ? { "x-project-id": options.projectId } : {}),
    },
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries ?? 1,
  });

  const addPath = options.addPath ?? "/v1/memories/";
  const searchPath = options.searchPath ?? "/v1/memories/search/";

  return {
    async search(query, scope) {
      const response = await transport.request<unknown>(searchPath, {
        method: "POST",
        body: { query, ...toMem0Scope(scope) },
      });
      return toRecords(response);
    },

    async add(messages: Message[], scope) {
      // mem0 stores conversational turns; tool metadata is not meaningful to
      // it, so only role and content are sent.
      await transport.request<unknown>(addPath, {
        method: "POST",
        body: {
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          ...toMem0Scope(scope),
        },
      });
    },
  };
}

/**
 * Build a mem0 store from the environment, or return undefined when no key is
 * set. Used to decide whether `memory: true` can activate mem0.
 */
export function mem0FromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Mem0StoreOptions = {},
): MemoryStore | undefined {
  const apiKey = options.apiKey ?? env[MEM0_ENV_VAR];
  if (!apiKey) return undefined;
  return mem0Store({ ...options, apiKey });
}
