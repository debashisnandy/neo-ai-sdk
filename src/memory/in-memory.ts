/**
 * A process-local MemoryStore, for development and tests.
 *
 * Scoring is naive keyword overlap — enough to exercise the wiring without a
 * network call or an API key. It is not a substitute for a real memory
 * backend: nothing is persisted, and there is no semantic search.
 */

import type { Message } from "../core/types.js";
import type { MemoryRecord, MemoryScope, MemoryStore } from "./types.js";

interface Stored extends MemoryRecord {
  key: string;
}

/** Scope fields collapsed into one bucket key. */
function scopeKey(scope: MemoryScope): string {
  return [scope.userId ?? "", scope.agentId ?? "", scope.runId ?? ""].join("|");
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export interface InMemoryStore extends MemoryStore {
  /** Everything remembered for a scope, in insertion order. */
  all(scope?: MemoryScope): MemoryRecord[];
  clear(): void;
}

export function inMemoryStore(): InMemoryStore {
  const rows: Stored[] = [];
  let nextId = 0;

  return {
    async search(query, scope) {
      const key = scopeKey(scope);
      const terms = new Set(tokenize(query));

      return rows
        .filter((r) => r.key === key)
        .map((r) => {
          const words = tokenize(r.memory);
          const hits = words.filter((w) => terms.has(w)).length;
          return { record: r, score: words.length ? hits / words.length : 0 };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, scope.limit ?? 5)
        .map(({ record, score }) => ({ id: record.id, memory: record.memory, score }));
    },

    async add(messages: Message[], scope) {
      const key = scopeKey(scope);
      for (const message of messages) {
        if (!message.content) continue;
        rows.push({
          key,
          id: `mem_${nextId++}`,
          memory: `${message.role}: ${message.content}`,
          ...(scope.metadata ? { metadata: scope.metadata } : {}),
        });
      }
    },

    all(scope) {
      const key = scope ? scopeKey(scope) : undefined;
      return rows
        .filter((r) => key === undefined || r.key === key)
        .map(({ id, memory, metadata }) => ({ id, memory, metadata }));
    },

    clear() {
      rows.length = 0;
    },
  };
}
