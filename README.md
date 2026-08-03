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
- **Streaming** everywhere, via a normalized `StreamChunk`.
- **No runtime dependencies.** ESM + CJS, Node >= 20.11.

## Install

```bash
npm install neo-ai-sdk
```

## Contents

[Providers](#providers) · [Keys](#keys) · [Typed model ids](#typed-model-ids) ·
[Streaming](#streaming) · [Tool calling](#tool-calling) · [Messages](#messages) ·
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
  finishReason: "stop" | "length" | "content_filter" | "tool_use" | "error";
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
| `APIError` `AuthenticationError` `RateLimitError` `TimeoutError` | class | Error subclasses |
| `Provider` | type | Interface for custom backends |
| `Message` `Role` `Tool` `ToolCall` `ToolChoice` `JSONSchema` | type | Request types |
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
