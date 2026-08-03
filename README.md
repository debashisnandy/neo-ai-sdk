# neo-ai-sdk

One typed client for eight model providers. Address any model as
`"<company>/<model>"` — the SDK routes to the right API, translates the wire
format, and normalizes the response.

```ts
import { NeoClient } from "neo-ai-sdk";

const ai = new NeoClient({ apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY } });

const result = await ai.generate({
  model: "anthropic/claude-opus-5",
  messages: [{ role: "user", content: "Explain SSE in one sentence." }],
});

console.log(result.text);
```

- **Typed model ids** — an unknown provider prefix is a compile-time error.
- **One result shape** — same `text` / `usage` / `finishReason` from every provider.
- **Tool calling** with one normalized shape across all three wire formats.
- **Structured output** — pass a Zod (or any Standard Schema) schema, get a typed object.
- **Streaming** everywhere, via a normalized `StreamChunk`.
- **Guardrails** — validate, redact, or require approval before and after a call.
- **Memory** — optional long-term memory: set MEM0_API_KEY and `memory: true`.
- **Multi-agent orchestration** — let the model split big tasks across sub-agents.
- **No runtime dependencies.** ESM + CJS, Node >= 20.11.

## Install

```bash
npm install neo-ai-sdk
```

## Contents

[Providers](#providers) · [Keys](#keys) · [Typed model ids](#typed-model-ids) ·
[Streaming](#streaming) · [Tool calling](#tool-calling) · [Structured output](#structured-output) ·
[Guardrails](#guardrails) · [Memory](#memory-optional) ·
[Multi-agent orchestration](#multi-agent-orchestration) ·
[Messages](#messages) ·
[Configuration](#configuration) · [Errors](#errors) ·
[Result shape](#result-shape) · [Custom providers](#custom-providers) ·
[Exports](#exports)

## Providers

| Prefix | API | Env var | Example model id |
| --- | --- | --- | --- |
| `openai` | OpenAI | `OPENAI_API_KEY` | `openai/gpt-5` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-opus-5` |
| `xai` | xAI | `XAI_API_KEY` | `xai/grok-4` |
| `gemini` | Google Gemini | `GEMINI_API_KEY` | `gemini/gemini-2.5-flash` |
| `mistral` | Mistral | `MISTRAL_API_KEY` | `mistral/mistral-large-latest` |
| `alibaba` | Alibaba (Qwen) | `DASHSCOPE_API_KEY` | `alibaba/qwen-plus` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat` |
| `meta` | Meta (Llama) | `LLAMA_API_KEY` | `meta/llama-4-maverick` |

Model names above are illustrative — check each provider's docs for what's
current. Only the **prefix** is validated by the SDK; the model half is passed
through untouched, so new model releases work without an SDK update.

## Keys

Pass keys explicitly, or let the SDK read the environment variables above:

```ts
// From the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, …)
const ai = new NeoClient({});
```

```ts
// Explicit keys, which win over the environment
const ai = new NeoClient({ apiKeys: { openai: "sk-...", deepseek: "sk-..." } });
```

You only need keys for the providers you actually call. Requesting a provider
with no key throws a `NeoError` naming it.

## Typed model ids

The `model` field is a template-literal type, so typos are caught before runtime:

```ts
ai.generate({ model: "anthropic/claude-opus-5", messages });  // ok
ai.generate({ model: "foobar/whatever", messages });          // Type error
```

This works on string literals. A model id that arrives as a plain `string` (from
config, a database, or an `as` cast) can't be checked by the compiler — those are
validated at runtime instead, and throw `NeoError`. Use `parseModelId` to check
one yourself:

```ts
import { parseModelId } from "neo-ai-sdk";

parseModelId("anthropic/claude-opus-5");
// -> { provider: "anthropic", model: "claude-opus-5" }
```

## Streaming

```ts
for await (const chunk of ai.stream({
  model: "openai/gpt-5",
  messages: [{ role: "user", content: "Write a haiku." }],
})) {
  process.stdout.write(chunk.delta);
  if (chunk.usage) console.log("\n", chunk.usage);
}
```

Every chunk carries a `delta`; the final one also carries `usage`. Some
providers omit usage on streamed responses, so treat it as optional.

## Tool calling

Declare tools once; the SDK translates them to each provider's format and
normalizes the calls that come back.

```ts
import { NeoClient, type Tool } from "neo-ai-sdk";

const getWeather: Tool = {
  name: "get_weather",
  description: "Look up the current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const messages = [{ role: "user", content: "What's the weather in Oslo?" }];

const result = await ai.generate({
  model: "anthropic/claude-opus-5",
  messages,
  tools: [getWeather],
});

if (result.finishReason === "tool_use") {
  // Append the assistant turn, then one message per tool result.
  messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });

  for (const call of result.toolCalls) {
    messages.push({
      role: "tool",
      toolCallId: call.id,
      content: JSON.stringify(await runTool(call.name, call.arguments)),
    });
  }

  const final = await ai.generate({ model: "anthropic/claude-opus-5", messages, tools: [getWeather] });
  console.log(final.text);
}
```

That loop is identical for every provider — swap the model id and nothing else
changes.

`call.arguments` is already a parsed object. If a model emits malformed JSON the
SDK throws a `NeoError` naming the tool rather than handing you `{}`, so a tool
never runs with silently-wrong arguments.

### Controlling tool choice

```ts
toolChoice: "auto"                  // model decides (default when tools present)
toolChoice: "none"                  // never call a tool
toolChoice: "required"              // must call some tool
toolChoice: { name: "get_weather" } // must call this one
```

### Streaming tool calls

Providers stream tool arguments as JSON fragments. The SDK accumulates them and
emits complete calls in a single final chunk, so you never see partial JSON:

```ts
for await (const chunk of ai.stream({ model: "openai/gpt-5", messages, tools: [getWeather] })) {
  if (chunk.delta) process.stdout.write(chunk.delta);
  if (chunk.toolCalls) console.log("\ncalls:", chunk.toolCalls);
}
```

### A note on Gemini

Gemini has no tool-call ids — it matches a result to its call by function
*name*. The SDK synthesizes ids (`call_0`, `call_1`, …) so your code looks the
same everywhere, and resolves them back to names when sending results. You can
ignore this unless you persist conversations across providers.

## Structured output

Pass a schema and get a typed, validated object back instead of prose.

```ts
import { z } from "zod";

const Recipe = z.object({
  name: z.string(),
  minutes: z.number(),
  steps: z.array(z.string()),
});

const result = await ai.generate({
  model: "openai/gpt-5",
  messages: [{ role: "user", content: "Give me a recipe for toast." }],
  output: Recipe,
});

result.object.minutes;    // number — fully typed, no cast
result.object.steps[0];   // string | undefined
result.text;              // the same data as raw JSON
```

`result.object` is typed from the schema and guaranteed present when you pass
`output` — no null check needed.

### Any schema library

The SDK has **no dependency on Zod**. It accepts any
[Standard Schema](https://standardschema.dev) implementation — Zod 3.24+,
Valibot, ArkType — and wires validation to whichever you use.

Zod 4 schemas convert themselves to JSON Schema, so they work as shown above.
For a library that can't, supply the JSON Schema once with `fromSchema`:

```ts
import { fromSchema } from "neo-ai-sdk";

const output = fromSchema(MySchema, myJsonSchema, { name: "recipe" });
await ai.generate({ model, messages, output });
```

Plain JSON Schema works too, with no schema library at all:

```ts
output: {
  name: "recipe",
  jsonSchema: {
    type: "object",
    properties: { name: { type: "string" }, minutes: { type: "number" } },
    required: ["name", "minutes"],
  },
}
```

Without a `parse` function you get the decoded JSON untyped — the provider
still constrains the shape, but nothing validates it client-side.

### How each provider enforces it

| Provider | Mechanism |
| --- | --- |
| OpenAI-compatible | `response_format: { type: "json_schema", strict: true }` |
| Gemini | `responseMimeType: "application/json"` + `responseSchema` |
| Anthropic | the schema is declared as a single **forced tool call** |

Anthropic has no JSON mode, so the SDK models the schema as a tool and requires
the model to call it. That is invisible from the outside: `result.object` is
populated, `toolCalls` stays empty, and `finishReason` is `"stop"`.

### Errors and limits

Anything that would hand you unusable data throws a `NeoError`:

- the model returns invalid JSON,
- the JSON violates the schema (the message names the failing path, e.g.
  `steps.0: expected string`),
- Anthropic answers with prose instead of calling the tool.

Two limits worth knowing:

- **`output` and `tools` cannot be combined.** Anthropic implements one using
  the other, so allowing it would work on some providers and not others.
  Run structured output as a separate call.
- **Asynchronous schema validation is rejected.** Zod's `.refine(async …)`
  throws rather than being silently skipped.

## Guardrails

Validate and transform requests before they are sent, and responses before you
act on them.

```ts
import { NeoClient, denyTools, redact, maxInputLength } from "neo-ai-sdk";

const ai = new NeoClient({
  apiKeys: { openai: process.env.OPENAI_API_KEY },
  guardrails: [
    maxInputLength(50_000),
    redact({ stages: ["input"] }),        // never send secrets to a provider
    denyTools(["delete_database"]),        // never let the model call this
  ],
});
```

Guardrails hook three points:

| Hook | Runs | Can |
| --- | --- | --- |
| `input` | before the request is sent | reject the request, or rewrite messages |
| `toolCall` | on each tool the model asks for | block it, rewrite arguments, await approval |
| `output` | after the response arrives | reject it, or rewrite it |

A denial throws a `GuardrailError` carrying `guardrail`, `stage`, and `reason`.

```ts
import { GuardrailError } from "neo-ai-sdk";

try {
  await ai.generate({ model: "openai/gpt-5", messages });
} catch (err) {
  if (err instanceof GuardrailError) {
    console.log(err.guardrail, err.stage, err.reason);
  }
}
```

Set them on the client (applies to every call) or per request via
`guardrails` — client ones run first.

### Built-in guardrails

```ts
maxInputLength(50_000)                       // reject oversized requests
blockInputPatterns({ patterns: [/^ignore previous/i] })

denyTools(["drop_table"])                    // block by name
allowTools(["search", "read_file"])          // safer: refuse anything else
blockToolArguments({ patterns: [/drop\s+table/i], tools: ["run_sql"] })

validateOutput({ check: (r) => r.text.length < 10 ? "too short" : undefined })
redact({ stages: ["input", "output"] })
```

### Requiring approval

`approve` may be async, so it can prompt a person or call a policy service:

```ts
import { requireApproval } from "neo-ai-sdk";

requireApproval({
  tools: ["send_email", "delete_records"],
  approve: async (call) => askOperator(`Run ${call.name} with ${JSON.stringify(call.arguments)}?`),
});
```

Returning `false` blocks the call with a `GuardrailError`. Tools not listed
skip the prompt entirely; omit `tools` to gate everything.

### Redaction

`redact()` rewrites rather than rejects — the request still goes through, minus
the sensitive parts. It covers emails, credit-card numbers, SSNs and common API
key shapes (`SENSITIVE_PATTERNS`), and scrubs **structured output too**, so
redaction can't be sidestepped by asking for JSON.

```ts
redact({ patterns: [/INTERNAL-\d+/g], replacement: "***", stages: ["output"] });
```

### Writing your own

A guardrail is a plain object. Return nothing to allow, `deny(reason)` to
block, or `modify(value)` to rewrite:

```ts
import { deny, modify, type Guardrail } from "neo-ai-sdk";

const businessHoursOnly: Guardrail = {
  name: "business-hours",
  toolCall({ toolCall }) {
    const hour = new Date().getHours();
    if (toolCall.name === "charge_card" && (hour < 9 || hour > 17)) {
      return deny("payments are only allowed 09:00–17:00");
    }
  },
};

const clampLimit: Guardrail = {
  name: "clamp-limit",
  toolCall: ({ toolCall }) =>
    modify({ ...toolCall, arguments: { ...toolCall.arguments, limit: 100 } }),
};
```

Each guardrail's modification feeds the next, so ordering matters: put
`redact` before a validator and the validator sees redacted data.

### Streaming

`stream()` applies **input** and **tool-call** guardrails — a dangerous call is
still blocked, because tool calls arrive complete in one chunk.

**Output guardrails do not run on streams.** Text is emitted incrementally, so
there is no complete response to validate before you have already received it.
Use `generate()` when an output guardrail must hold.

## Memory (optional)

Give the model long-term memory: relevant context is recalled before a call and
the exchange is persisted after it.

[mem0](https://mem0.ai) works with no install and no client object — the SDK
speaks mem0's REST API directly. Set the key and turn it on:

```bash
export MEM0_API_KEY=m0-...
```

```ts
const ai = new NeoClient({
  apiKeys: { openai: process.env.OPENAI_API_KEY },
  memory: true,                    // mem0, configured from MEM0_API_KEY
});

await ai.generate({
  model: "openai/gpt-5",
  messages: [{ role: "user", content: "What was I working on?" }],
  memory: { userId: "alice" },     // scope it to a user
});
```

That's the whole setup. **`mem0ai` is not a dependency** of this package — or
of your app. Nothing is imported; mem0 is just another HTTP backend.

`memory: true` also works per request, and `memory: false` turns it off for one
call even when the client has it on.

### Configuring mem0

```ts
memory: {
  mem0: {
    apiKey: "m0-...",                     // defaults to MEM0_API_KEY
    baseURL: "https://mem0.internal",     // self-hosted
    orgId: "org_123",
    projectId: "proj_456",
    searchPath: "/v2/memories/search/",   // if mem0 moves an endpoint
  },
  userId: "alice",
}
```

Both the base URL and the paths are overridable, so an API change on mem0's
side can be worked around without waiting for an SDK release.

### How it works

Recalled memories are injected as a **system message ahead of your
conversation**; your own messages are never rewritten. After the reply, the
latest user turn and the assistant's response are sent to mem0, which does its
own fact extraction and deduplication.

### Options

```ts
memory: {
  mem0: true,               // or a config object, or use your own `store`
  userId, agentId, runId,   // scoping, passed through to the backend
  limit: 5,                 // how many memories to recall
  recall: true,             // look up memories before the call
  persist: true,            // store the exchange after it
  strict: false,            // see below
  onError: (err, stage) => log(err, stage),   // "recall" | "persist"
  query:   (messages) => messages.at(-1)!.content,     // what to search on
  format:  (memories) => memories.map(m => m.memory).join("\n"),
  capture: (messages, result) => [...],                // what to store
}
```

### Failures are non-fatal by default

If mem0 is unreachable — or `MEM0_API_KEY` is missing — the call still
completes. Answer quality degrades, but your application stays up, and errors
surface through `onError`. Set `strict: true` to make memory failures fail the
request instead.

### Guardrails run around memory

Guardrails bracket memory on both sides:

```
input guardrails → recall → provider → tool-call guardrails → output guardrails → persist
```

So `redact()` scrubs text **before** it reaches the store. That ordering matters
more than usual here: memory is long-lived, and a secret written into it
persists well beyond the request that leaked it.

### Any backend

`MemoryStore` is two methods, so you can use your own vector store, Redis, or
Postgres instead. A `store` takes precedence over mem0:

```ts
import type { MemoryStore } from "neo-ai-sdk";

const store: MemoryStore = {
  async search(query, scope) {
    return [{ memory: "…" }];
  },
  async add(messages, scope) {
    /* persist */
  },
};

new NeoClient({ apiKeys, memory: { store, userId: "alice" } });
```

For development and tests, `inMemoryStore()` is a dependency-free store with
naive keyword matching — enough to exercise the wiring without an API key, but
not a substitute for a real backend.

## Multi-agent orchestration

Pass `orchestrate` and the model first decides whether the request is worth
splitting. If it is, independent subtasks run as parallel sub-agents and their
answers are synthesized into one response.

```ts
const result = await ai.generate({
  model: "openai/gpt-5",
  messages: [{ role: "user", content: "Compare Postgres, MySQL and SQLite for our workload." }],
  orchestrate: true,
});

console.log(result.text);              // the synthesized answer
console.log(result.orchestration);     // what actually happened
```

`result.orchestration` reports the decision:

```ts
{
  delegated: true,
  reasoning: "three independent databases to research",
  executor: "inline",
  subtasks: [
    { id: "postgres", prompt: "Describe Postgres…", text: "…", usage: {…} },
    { id: "mysql",    prompt: "Describe MySQL…",    text: "…", usage: {…} },
    { id: "sqlite",   prompt: "Describe SQLite…",   text: "…", usage: {…} },
  ],
}
```

When the planner judges the task simple, `delegated` is `false`, `subtasks` is
empty, and you get a normal single-call answer. `result.usage` is always the
**total** across planning, every sub-agent, and synthesis.

### Options

```ts
orchestrate: {
  executor: "inline",         // or "worker" — see below
  maxConcurrency: 4,          // sub-agents running at once
  maxSubtasks: 5,             // cap on what the planner may propose
  workers: 4,                 // threads when executor is "worker"
  plannerModel: "anthropic/claude-opus-5",  // planning + synthesis
  agentModel: "openai/gpt-5-mini",          // sub-agents
}
```

Splitting the models is often the point: plan with a strong model, fan out to a
cheaper one.

### Choosing an executor

`"inline"` (default) runs sub-agents as concurrent promises. `"worker"` runs
their HTTP requests on `node:worker_threads`.

**Inline is usually right.** Sub-agent time is almost entirely spent waiting on
HTTP, which promises already parallelize; threads add startup and serialization
cost without adding throughput. Measured on a 600 KB response with 4 sub-agents:

| Executor | Wall clock | Worst event-loop stall |
| --- | --- | --- |
| `inline` | 31 ms | 8 ms |
| `worker` | 70 ms | 4 ms |

Workers roughly halve main-thread stalls but roughly double wall-clock. That
trade only pays off in a server handling other concurrent traffic, where a long
`JSON.parse` on the main thread hurts everyone else's tail latency. If you are
running a script or a single request, use `inline`.

Streaming always uses the main thread — a worker cannot pass a live
`ReadableStream` back to its parent.

### Caveats

- Sub-agents are **independent**: each sees only its own prompt, never the
  others' output or the original conversation. Tasks needing shared context
  won't decompose well.
- Orchestration costs **at least two extra model calls** (planning and
  synthesis) on top of the sub-agents.
- A sub-agent that fails is recorded in `subtasks[].error` and the run
  continues; synthesis is told which parts are missing.
- The planner is a model, so its judgement varies. Use `maxSubtasks` as a hard
  ceiling on fan-out and cost.

## Messages

```ts
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[]; // assistant only — tools the model asked for
  toolCallId?: string;    // tool only — which call this answers
}
```

```ts
const messages = [
  { role: "system", content: "Answer in one sentence." },
  { role: "user", content: "What is SSE?" },
  { role: "assistant", content: "Server-Sent Events." },
  { role: "user", content: "How does it differ from WebSockets?" },
];
```

The same array works for every provider — the SDK reshapes it per API:

- **`system`** messages are hoisted into whatever field the target expects
  (Anthropic's `system`, Gemini's `systemInstruction`). Multiple system
  messages are joined.
- **`assistant`** messages with `toolCalls` become OpenAI `tool_calls`,
  Anthropic `tool_use` blocks, or Gemini `functionCall` parts.
- **`tool`** messages become an OpenAI `role: "tool"` message, an Anthropic
  `tool_result` block on a *user* turn, or a Gemini `functionResponse`.
  Consecutive tool results are merged where the provider requires it.

## Configuration

```ts
const ai = new NeoClient({
  apiKeys: { openai: "sk-..." },
  timeoutMs: 30_000,   // per request; default 60s
  maxRetries: 2,       // retries 429 / 5xx / network errors; default 0
  baseURLs: {          // proxies, gateways, regional or self-hosted endpoints
    openai: "https://my-gateway.internal/v1",
  },
});
```

Retries use exponential backoff with jitter and honor `Retry-After`. Requests
that can't succeed on retry (400, 401, 404) fail immediately. Streams are never
retried mid-flight.

Per-request options:

```ts
await ai.generate({
  model: "openai/gpt-5",
  messages,
  temperature: 0.2,
  maxTokens: 512,
  signal: AbortSignal.timeout(5_000),
});
```

## Errors

Every error extends `NeoError`:

```ts
import { AuthenticationError, RateLimitError, TimeoutError, APIError } from "neo-ai-sdk";

try {
  await ai.generate({ model: "openai/gpt-5", messages });
} catch (err) {
  if (err instanceof RateLimitError) console.log("slow down", err.retryAfter);
  else if (err instanceof AuthenticationError) console.log("bad key");
  else if (err instanceof TimeoutError) console.log("timed out");
  else if (err instanceof APIError) console.log(err.status, err.body);
  else throw err;
}
```

`APIError` carries the HTTP `status` and the parsed `body` from the provider.

## Result shape

```ts
interface GenerateResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: ToolCall[];
  object?: T;                         // typed + guaranteed when `output` is passed
  finishReason: "stop" | "length" | "content_filter" | "tool_use" | "error";
  orchestration?: OrchestrationTrace; // only when `orchestrate` was set
}
```

Provider-specific reasons are normalized — Anthropic's `max_tokens` and Gemini's
`MAX_TOKENS` both become `"length"`, for example. `"tool_use"` is reported
whenever the model asked for a tool, even by providers that report `"stop"` in
that case.

## Custom providers

Implement `Provider` to add a backend or to stub the SDK in tests:

```ts
import type { Provider } from "neo-ai-sdk";

const fake: Provider = {
  name: "fake",
  async generate({ model }) {
    return {
      text: "canned",
      model,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      finishReason: "stop",
    };
  },
  async *stream() {
    yield { delta: "canned" };
  },
};

const ai = new NeoClient({ provider: fake });
```

When you pass `provider`, the SDK does no key handling — your implementation
owns auth.

## Exports

Everything is a named export from `neo-ai-sdk`.

| Export | Kind | What it's for |
| --- | --- | --- |
| `NeoClient` | class | The client you instantiate |
| `UnifiedProvider` | class | The multi-provider router, if you want it without the client |
| `ProviderName` | enum | The eight provider prefixes |
| `PROVIDER_BASE_URLS` | const | Default base URL per provider |
| `parseModelId` | fn | Split `"<company>/<model>"`, validating the prefix |
| `apiKeysFromEnv` | fn | Read provider keys from an env object |
| `NeoError` | class | Base class for every error the SDK throws |
| `GuardrailError` | class | Thrown when a guardrail denies a request, tool call, or response |
| `deny` `modify` | fn | Guardrail decision helpers |
| `maxInputLength` `blockInputPatterns` `denyTools` `allowTools` `requireApproval` `blockToolArguments` `validateOutput` `redact` | fn | Built-in guardrails |
| `SENSITIVE_PATTERNS` | const | Default redaction patterns |
| `mem0Store` `mem0FromEnv` | fn | mem0-backed MemoryStore (also used by `memory: true`) |
| `inMemoryStore` | fn | Dependency-free store for dev and tests |
| `MemoryStore` `MemoryOptions` `MemorySpec` `MemoryRecord` `MemoryScope` `Mem0StoreOptions` | type | Memory types |
| `Guardrail` `GuardrailDecision` `InputContext` `ToolCallContext` `OutputContext` | type | Guardrail types |
| `APIError` `AuthenticationError` `RateLimitError` `TimeoutError` | class | Error subclasses |
| `Provider` | type | Interface for custom backends |
| `WorkerPool` | class | Thread pool behind the "worker" executor, usable directly |
| `fromSchema` | fn | Adapt a Standard Schema (Zod, Valibot, …) for structured output |
| `Message` `Role` `Tool` `ToolCall` `ToolChoice` `JSONSchema` | type | Request types |
| `OutputSchema` `OutputSpec` `InferOutput` `StandardSchemaV1` | type | Structured-output types |
| `OrchestrateOptions` `OrchestrationTrace` `SubtaskResult` | type | Orchestration types |
| `GenerateParams` `GenerateResult` `StreamChunk` `Usage` | type | Call and response types |
| `ProviderModelId` `ParsedModelId` | type | Model-id types |
| `NeoClientOptions` `UnifiedProviderOptions` `UnifiedGenerateParams` | type | Options types |

Using `UnifiedProvider` directly, without `NeoClient`:

```ts
import { UnifiedProvider, ProviderName } from "neo-ai-sdk";

const provider = new UnifiedProvider({
  apiKeys: { [ProviderName.OpenAI]: "sk-..." },
  maxRetries: 2,
});

await provider.generate({ model: "openai/gpt-5", messages });
```

## Server-side only

This package targets Node.js >= 20.11. Browser bundles resolve to a stub that
throws: API keys must never ship to a browser. Call it from a server route or
backend service.

## Contributing

```bash
npm install
npm test          # 123 tests, no network — fetch is stubbed
npm run typecheck # src + tests
npm run build     # dual ESM/CJS + declarations
```

Provider wire formats live in `src/providers/`; add a backend by implementing
`Provider`, or extend `ProviderName` plus its base URL and wire format to add
one to the registry.

## License

MIT © Debashis Nandy
