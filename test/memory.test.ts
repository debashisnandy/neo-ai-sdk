/**
 * Memory tests: the recall/persist lifecycle, the mem0 adapter's translation
 * to and from mem0's wire shape, and the interaction with guardrails.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { UnifiedProvider } from "../src/providers/unified.js";
import { inMemoryStore } from "../src/memory/in-memory.js";
import { mem0FromEnv, mem0Store } from "../src/memory/mem0.js";
import { NeoError } from "../src/core/errors.js";
import { redact } from "../src/guardrails/builtin.js";
import type { MemoryStore } from "../src/memory/types.js";
import type { Message } from "../src/core/types.js";
import { jsonResponse, mockFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ASK: Message[] = [{ role: "user", content: "what is my favourite colour?" }];

function reply(text: string) {
  return jsonResponse({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

/** Records every interaction so tests can assert on the exact calls. */
function spyStore(memories: string[] = []): MemoryStore & {
  searches: Array<{ query: string; scope: Record<string, unknown> }>;
  added: Array<{ messages: Message[]; scope: Record<string, unknown> }>;
} {
  const searches: Array<{ query: string; scope: Record<string, unknown> }> = [];
  const added: Array<{ messages: Message[]; scope: Record<string, unknown> }> = [];
  return {
    searches,
    added,
    async search(query, scope) {
      searches.push({ query, scope: scope as Record<string, unknown> });
      return memories.map((m, i) => ({ id: `m${i}`, memory: m, score: 1 - i / 10 }));
    },
    async add(messages, scope) {
      added.push({ messages, scope: scope as Record<string, unknown> });
    },
  };
}

describe("recall", () => {
  it("injects recalled memories as a system message ahead of the conversation", async () => {
    const store = spyStore(["User's favourite colour is blue", "User lives in Oslo"]);
    const fetchMock = mockFetch([reply("Blue.")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "alice" },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    const sent = fetchMock.one.body.messages;
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toContain("favourite colour is blue");
    expect(sent[0].content).toContain("lives in Oslo");
    // The caller's own messages must survive untouched, after the injection.
    expect(sent[1]).toEqual({ role: "user", content: ASK[0]!.content });
  });

  it("searches on the last user message and passes the scope through", async () => {
    const store = spyStore(["x"]);
    mockFetch([reply("ok")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "alice", agentId: "support", limit: 3 },
    }).generate({
      model: "openai/gpt-5",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "the latest question" },
      ],
    });

    expect(store.searches[0]!.query).toBe("the latest question");
    expect(store.searches[0]!.scope).toMatchObject({
      userId: "alice",
      agentId: "support",
      limit: 3,
    });
  });

  it("sends the conversation unchanged when nothing is recalled", async () => {
    const fetchMock = mockFetch([reply("ok")]);
    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store: spyStore([]), userId: "alice" },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(fetchMock.one.body.messages).toHaveLength(1);
    expect(fetchMock.one.body.messages[0].role).toBe("user");
  });

  it("honours a custom format and query", async () => {
    const store = spyStore(["fact one"]);
    const fetchMock = mockFetch([reply("ok")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: {
        store,
        userId: "alice",
        query: () => "custom query",
        format: (memories) => `KNOWN: ${memories.map((m) => m.memory).join("|")}`,
      },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(store.searches[0]!.query).toBe("custom query");
    expect(fetchMock.one.body.messages[0].content).toBe("KNOWN: fact one");
  });

  it("can be disabled with recall: false", async () => {
    const store = spyStore(["x"]);
    mockFetch([reply("ok")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "alice", recall: false },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(store.searches).toHaveLength(0);
    expect(store.added).toHaveLength(1); // persist still runs
  });
});

describe("persist", () => {
  it("stores the exchange after the reply", async () => {
    const store = spyStore();
    mockFetch([reply("Your favourite colour is blue.")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "alice" },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(store.added).toHaveLength(1);
    expect(store.added[0]!.messages).toEqual([
      { role: "user", content: "what is my favourite colour?" },
      { role: "assistant", content: "Your favourite colour is blue." },
    ]);
    expect(store.added[0]!.scope).toMatchObject({ userId: "alice" });
  });

  // Recalled memories are prompt scaffolding, not new facts to re-store.
  it("does not write the injected memory back into the store", async () => {
    const store = spyStore(["User's favourite colour is blue"]);
    mockFetch([reply("Blue.")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "alice" },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    const roles = store.added[0]!.messages.map((m) => m.role);
    expect(roles).not.toContain("system");
  });

  /**
   * The default capture only keeps user/assistant turns, which hides whether
   * `capture` was handed the pre- or post-recall messages. A capture that
   * returns everything exposes it: recalled memories must not be re-stored,
   * or each call would compound the last one's context.
   */
  it("hands capture the messages as they were before recall", async () => {
    const store = spyStore(["User's favourite colour is blue"]);
    mockFetch([reply("Blue.")]);
    let captured: Message[] = [];

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: {
        store,
        userId: "alice",
        capture: (messages) => {
          captured = messages;
          return messages;
        },
      },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(captured).toEqual(ASK);
    expect(JSON.stringify(captured)).not.toContain("favourite colour is blue");
  });

  it("can be disabled with persist: false", async () => {
    const store = spyStore(["x"]);
    mockFetch([reply("ok")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "alice", persist: false },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(store.added).toHaveLength(0);
    expect(store.searches).toHaveLength(1);
  });

  it("honours a custom capture", async () => {
    const store = spyStore();
    mockFetch([reply("answer")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: {
        store,
        userId: "alice",
        capture: (_messages, result) => [{ role: "assistant", content: `LOG:${result.text}` }],
      },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(store.added[0]!.messages).toEqual([{ role: "assistant", content: "LOG:answer" }]);
  });
});

describe("failure handling", () => {
  const broken: MemoryStore = {
    async search() {
      throw new Error("mem0 unreachable");
    },
    async add() {
      throw new Error("mem0 unreachable");
    },
  };

  // A memory backend outage degrades answers; it should not break the app.
  it("still answers when the store fails", async () => {
    mockFetch([reply("answered anyway")]);
    const result = await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store: broken, userId: "alice" },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(result.text).toBe("answered anyway");
  });

  it("reports failures through onError, naming the stage", async () => {
    mockFetch([reply("ok")]);
    const seen: Array<{ stage: string; message: string }> = [];

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: {
        store: broken,
        userId: "alice",
        onError: (err, stage) => seen.push({ stage, message: (err as Error).message }),
      },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(seen.map((s) => s.stage)).toEqual(["recall", "persist"]);
    expect(seen[0]!.message).toBe("mem0 unreachable");
  });

  it("fails the request when strict is set", async () => {
    mockFetch([reply("ok")]);
    await expect(
      new UnifiedProvider({
        apiKeys: { openai: "k" },
        memory: { store: broken, userId: "alice", strict: true },
      }).generate({ model: "openai/gpt-5", messages: ASK }),
    ).rejects.toThrow(/unreachable/);
  });

  it("explains how to configure a backend when none is set", async () => {
    mockFetch([reply("ok")]);
    const promise = new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { userId: "alice", strict: true },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    await expect(promise).rejects.toBeInstanceOf(NeoError);
    await expect(promise).rejects.toThrow(/MEM0_API_KEY|memory: \{ store \}/);
  });
});

describe("per-request overrides", () => {
  it("merges client memory options with per-request ones", async () => {
    const store = spyStore(["x"]);
    mockFetch([reply("ok")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "default-user", limit: 5 },
    }).generate({
      model: "openai/gpt-5",
      messages: ASK,
      memory: { userId: "request-user" }, // store + limit inherited
    });

    expect(store.searches[0]!.scope).toMatchObject({ userId: "request-user", limit: 5 });
  });

  it("works with memory supplied only per request", async () => {
    const store = spyStore(["x"]);
    mockFetch([reply("ok")]);

    await new UnifiedProvider({ apiKeys: { openai: "k" } }).generate({
      model: "openai/gpt-5",
      messages: ASK,
      memory: { store, userId: "alice" },
    });

    expect(store.searches).toHaveLength(1);
  });
});

describe("guardrail interaction", () => {
  // Redaction must win: memory is long-lived, so a secret stored there persists.
  it("stores redacted text, never the original secret", async () => {
    const store = spyStore();
    mockFetch([reply("I will mail you at bob@example.com")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      guardrails: [redact()],
      memory: { store, userId: "alice" },
    }).generate({
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "my email is alice@example.com" }],
    });

    const stored = JSON.stringify(store.added[0]!.messages);
    expect(stored).not.toContain("alice@example.com");
    expect(stored).not.toContain("bob@example.com");
    expect(stored).toContain("[REDACTED]");
  });
});

describe("mem0 store (HTTP)", () => {
  const KEY = "m0-test-key";

  it("posts a search to mem0 with Token auth and snake_case scope", async () => {
    const fetchMock = mockFetch([jsonResponse({ results: [] })]);
    await mem0Store({ apiKey: KEY }).search("what did I say?", {
      userId: "alice",
      agentId: "bot",
      runId: "r1",
      limit: 4,
    });

    const req = fetchMock.one;
    expect(req.url).toBe("https://api.mem0.ai/v1/memories/search/");
    expect(req.method).toBe("POST");
    // mem0 uses the "Token" scheme, not "Bearer".
    expect(req.headers["authorization"]).toBe(`Token ${KEY}`);
    expect(req.body).toEqual({
      query: "what did I say?",
      user_id: "alice",
      agent_id: "bot",
      run_id: "r1",
      limit: 4,
    });
  });

  it("omits scope fields that were not provided", async () => {
    const fetchMock = mockFetch([jsonResponse([])]);
    await mem0Store({ apiKey: KEY }).search("q", { userId: "alice" });
    expect(fetchMock.one.body).toEqual({ query: "q", user_id: "alice" });
  });

  it("posts memories to the add endpoint with role/content only", async () => {
    const fetchMock = mockFetch([jsonResponse({})]);
    await mem0Store({ apiKey: KEY }).add(
      [{ role: "assistant", content: "hi", toolCalls: [{ id: "c", name: "t", arguments: {} }] }],
      { userId: "alice" },
    );

    expect(fetchMock.one.url).toBe("https://api.mem0.ai/v1/memories/");
    expect(fetchMock.one.body).toEqual({
      messages: [{ role: "assistant", content: "hi" }],
      user_id: "alice",
    });
  });

  it("reads a bare array response", async () => {
    mockFetch([jsonResponse([{ id: "1", memory: "likes blue", score: 0.9 }])]);
    await expect(mem0Store({ apiKey: KEY }).search("q", {})).resolves.toEqual([
      { id: "1", memory: "likes blue", score: 0.9 },
    ]);
  });

  // mem0 has returned both shapes across versions; an upgrade must not
  // silently start yielding zero memories.
  it("reads a { results: [...] } response", async () => {
    mockFetch([jsonResponse({ results: [{ id: "1", memory: "likes blue" }] })]);
    await expect(mem0Store({ apiKey: KEY }).search("q", {})).resolves.toEqual([
      { id: "1", memory: "likes blue" },
    ]);
  });

  it("accepts `text` as an alias for `memory`", async () => {
    mockFetch([jsonResponse([{ id: "1", text: "likes blue" }])]);
    await expect(mem0Store({ apiKey: KEY }).search("q", {})).resolves.toEqual([
      { id: "1", memory: "likes blue" },
    ]);
  });

  it("skips rows with no usable text instead of yielding empty memories", async () => {
    mockFetch([jsonResponse([{ id: "1" }, null, "nope", { id: "2", memory: "kept" }])]);
    await expect(mem0Store({ apiKey: KEY }).search("q", {})).resolves.toEqual([
      { id: "2", memory: "kept" },
    ]);
  });

  it("supports a self-hosted base URL and custom paths", async () => {
    const fetchMock = mockFetch([jsonResponse([])]);
    await mem0Store({
      apiKey: KEY,
      baseURL: "https://mem0.internal",
      searchPath: "/v2/memories/search/",
    }).search("q", {});
    expect(fetchMock.one.url).toBe("https://mem0.internal/v2/memories/search/");
  });

  it("sends org and project headers when configured", async () => {
    const fetchMock = mockFetch([jsonResponse([])]);
    await mem0Store({ apiKey: KEY, orgId: "org1", projectId: "proj1" }).search("q", {});
    expect(fetchMock.one.headers["x-organization-id"]).toBe("org1");
    expect(fetchMock.one.headers["x-project-id"]).toBe("proj1");
  });

  it("reads the key from MEM0_API_KEY", async () => {
    vi.stubEnv("MEM0_API_KEY", "from-env");
    const fetchMock = mockFetch([jsonResponse([])]);
    await mem0Store().search("q", {});
    expect(fetchMock.one.headers["authorization"]).toBe("Token from-env");
  });

  it("throws at construction when no key is available", () => {
    vi.stubEnv("MEM0_API_KEY", "");
    expect(() => mem0Store()).toThrow(/MEM0_API_KEY/);
  });

  it("mem0FromEnv returns undefined when the key is absent", () => {
    expect(mem0FromEnv({})).toBeUndefined();
    expect(mem0FromEnv({ MEM0_API_KEY: "k" })).toBeDefined();
  });
});

describe("memory: true", () => {
  it("activates mem0 from MEM0_API_KEY with no other configuration", async () => {
    vi.stubEnv("MEM0_API_KEY", "env-key");
    const fetchMock = mockFetch([
      jsonResponse({ results: [{ id: "1", memory: "User prefers concise answers" }] }),
      reply("Short answer."),
      jsonResponse({}),
    ]);

    const result = await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: true,
    }).generate({ model: "openai/gpt-5", messages: ASK, memory: { userId: "alice" } });

    expect(result.text).toBe("Short answer.");
    // 1: mem0 search, 2: the model call, 3: mem0 add
    expect(fetchMock.calls).toHaveLength(3);
    expect(fetchMock.calls[0]!.url).toContain("/v1/memories/search/");
    expect(fetchMock.calls[0]!.headers["authorization"]).toBe("Token env-key");

    // The recalled memory reached the model as a system message.
    expect(fetchMock.calls[1]!.body.messages[0].content).toContain("prefers concise answers");

    expect(fetchMock.calls[2]!.url).toContain("/v1/memories/");
    expect(fetchMock.calls[2]!.body.user_id).toBe("alice");
  });

  it("works as a per-request flag too", async () => {
    vi.stubEnv("MEM0_API_KEY", "env-key");
    const fetchMock = mockFetch([jsonResponse({ results: [] }), reply("ok"), jsonResponse({})]);

    await new UnifiedProvider({ apiKeys: { openai: "k" } }).generate({
      model: "openai/gpt-5",
      messages: ASK,
      memory: true,
    });
    expect(fetchMock.calls[0]!.url).toContain("mem0.ai");
  });

  it("accepts inline mem0 configuration", async () => {
    const fetchMock = mockFetch([jsonResponse([]), reply("ok"), jsonResponse({})]);
    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { mem0: { apiKey: "inline", baseURL: "https://mem0.internal" }, userId: "alice" },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(fetchMock.calls[0]!.url).toBe("https://mem0.internal/v1/memories/search/");
    expect(fetchMock.calls[0]!.headers["authorization"]).toBe("Token inline");
  });

  it("explains what to do when mem0 is on but no key is set", async () => {
    vi.stubEnv("MEM0_API_KEY", "");
    mockFetch([reply("ok")]);

    await expect(
      new UnifiedProvider({ apiKeys: { openai: "k" }, memory: { mem0: true, strict: true } })
        .generate({ model: "openai/gpt-5", messages: ASK }),
    ).rejects.toThrow(/MEM0_API_KEY/);
  });

  // Memory failures are non-fatal, so a missing key must not break the app.
  it("still answers when mem0 is on but unconfigured and not strict", async () => {
    vi.stubEnv("MEM0_API_KEY", "");
    mockFetch([reply("answered anyway")]);

    const result = await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: true,
    }).generate({ model: "openai/gpt-5", messages: ASK });
    expect(result.text).toBe("answered anyway");
  });

  it("memory: false on a request switches it off", async () => {
    vi.stubEnv("MEM0_API_KEY", "env-key");
    const fetchMock = mockFetch([reply("ok")]);

    await new UnifiedProvider({ apiKeys: { openai: "k" }, memory: true }).generate({
      model: "openai/gpt-5",
      messages: ASK,
      memory: false,
    });

    expect(fetchMock.calls).toHaveLength(1); // model call only
  });

  /**
   * combineMemory returns a fresh options object per call, so caching the
   * store by that object would never hit. Two calls must reuse one store
   * rather than rebuild a Transport each time.
   */
  it("reuses one mem0 store across calls", async () => {
    vi.stubEnv("MEM0_API_KEY", "env-key");
    const ai = new UnifiedProvider({ apiKeys: { openai: "k" }, memory: true });

    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const fetchMock = mockFetch([jsonResponse({ results: [] }), reply("ok"), jsonResponse({})]);
      await ai.generate({ model: "openai/gpt-5", messages: ASK, memory: { userId: "alice" } });
      seen.add(fetchMock.calls[0]!.headers["authorization"]!);
      vi.unstubAllGlobals();
    }
    // Same credentials both times: one store, not two ad-hoc ones.
    expect(seen.size).toBe(1);
  });

  it("an explicit store wins over mem0", async () => {
    vi.stubEnv("MEM0_API_KEY", "env-key");
    const store = spyStore(["custom"]);
    const fetchMock = mockFetch([reply("ok")]);

    await new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { mem0: true, store, userId: "alice" },
    }).generate({ model: "openai/gpt-5", messages: ASK });

    expect(store.searches).toHaveLength(1);
    expect(fetchMock.calls).toHaveLength(1); // no mem0 HTTP traffic
  });
});

describe("inMemoryStore", () => {
  it("recalls what was stored for the same scope", async () => {
    const store = inMemoryStore();
    await store.add([{ role: "user", content: "my favourite colour is blue" }], { userId: "alice" });

    const found = await store.search("favourite colour", { userId: "alice" });
    expect(found[0]!.memory).toContain("blue");
  });

  it("keeps scopes isolated", async () => {
    const store = inMemoryStore();
    await store.add([{ role: "user", content: "alice likes blue" }], { userId: "alice" });
    expect(await store.search("blue", { userId: "bob" })).toEqual([]);
  });

  it("supports a full round trip through the provider", async () => {
    const store = inMemoryStore();
    const ai = new UnifiedProvider({
      apiKeys: { openai: "k" },
      memory: { store, userId: "alice" },
    });

    mockFetch([reply("Noted.")]);
    await ai.generate({
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "my favourite colour is blue" }],
    });
    vi.unstubAllGlobals();

    const fetchMock = mockFetch([reply("Blue.")]);
    await ai.generate({
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "what is my favourite colour?" }],
    });

    // The second call should have been given the first exchange as context.
    expect(fetchMock.one.body.messages[0].content).toContain("blue");
  });
});
