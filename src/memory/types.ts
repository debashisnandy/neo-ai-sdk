/**
 * Long-term memory: recall relevant context before a call, persist the
 * exchange after it.
 *
 * The SDK depends on the MemoryStore interface below, never on a specific
 * provider. mem0 is supported through an adapter (see mem0.ts) that is given a
 * client you construct, so `mem0ai` stays a dependency of your app rather than
 * of this package.
 */

import type { GenerateResult, Message } from "../core/types.js";
import type { Mem0StoreOptions } from "./mem0.js";

/**
 * What callers may pass as `memory`.
 * `true` means "use mem0, configured from MEM0_API_KEY".
 */
export type MemorySpec = boolean | MemoryOptions;

/** Who or what a memory belongs to. Mirrors mem0's scoping fields. */
export interface MemoryScope {
  userId?: string;
  agentId?: string;
  runId?: string;
  /** Extra fields passed through to the store unchanged. */
  metadata?: Record<string, unknown>;
}

/** One recalled memory. */
export interface MemoryRecord {
  id?: string;
  /** The remembered text. */
  memory: string;
  /** Relevance, when the store provides one. */
  score?: number;
  metadata?: Record<string, unknown>;
}

/**
 * The contract a memory backend must satisfy. Deliberately tiny — two methods
 * cover recall and persistence, and anything can implement it.
 */
export interface MemoryStore {
  /** Find memories relevant to `query`. */
  search(query: string, scope: MemoryScope & { limit?: number }): Promise<MemoryRecord[]>;
  /** Persist an exchange. Extraction/deduplication is the store's business. */
  add(messages: Message[], scope: MemoryScope): Promise<void>;
}

export interface MemoryOptions extends MemoryScope {
  /**
   * Use mem0 as the backend, configured from MEM0_API_KEY.
   *
   *   memory: { mem0: true, userId }              // from the environment
   *   memory: { mem0: { apiKey, baseURL }, … }    // explicit
   *
   * Ignored when `store` is set. `memory: true` is shorthand for
   * `{ mem0: true }`.
   */
  mem0?: boolean | Mem0StoreOptions;
  /**
   * The backend. Defaults to mem0 when `mem0` is enabled; otherwise required
   * once client and per-request options are merged.
   */
  store?: MemoryStore;
  /** How many memories to recall. Default 5. */
  limit?: number;
  /** Recall memories before the call. Default true. */
  recall?: boolean;
  /** Persist the exchange after the call. Default true. */
  persist?: boolean;
  /**
   * Fail the request when the store errors. Default false — a memory backend
   * being down degrades quality but should not take an application offline.
   * Errors are still reported through `onError`.
   */
  strict?: boolean;
  /** Called when the store throws, whether or not `strict` is set. */
  onError?: (error: unknown, stage: "recall" | "persist") => void;
  /** What to search on. Default: the last user message. */
  query?: (messages: Message[]) => string;
  /** How recalled memories become prompt text. */
  format?: (memories: MemoryRecord[]) => string;
  /** What to persist. Default: the last user message plus the reply. */
  capture?: (messages: Message[], result: GenerateResult) => Message[];
}

/** Default rendering of recalled memories into a system message. */
export function defaultFormat(memories: MemoryRecord[]): string {
  const lines = memories.map((m) => `- ${m.memory}`).join("\n");
  return `Relevant context about this user from previous conversations:\n${lines}`;
}

/** Default query: the most recent user message. */
export function defaultQuery(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user" && message.content) return message.content;
  }
  return "";
}

/** Default capture: the latest user turn and the assistant's reply. */
export function defaultCapture(messages: Message[], result: GenerateResult): Message[] {
  const captured: Message[] = [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) captured.push({ role: "user", content: lastUser.content });
  if (result.text) captured.push({ role: "assistant", content: result.text });
  return captured;
}
