/**
 * Multi-agent orchestration: plan → delegate → synthesize.
 *
 *   1. Planning   — the model is asked, via a forced tool call, whether the
 *                   request is big enough to split and what the subtasks are.
 *   2. Delegation — each subtask runs as an independent sub-agent, bounded by
 *                   maxConcurrency. Sub-agents do not see each other's work,
 *                   so subtasks must be genuinely independent.
 *   3. Synthesis  — the sub-agent answers are fed back for a final response.
 *
 * The runner functions are injected, which keeps this module free of any
 * provider or transport detail and makes it directly testable.
 */

import type {
  GenerateParams,
  GenerateResult,
  Message,
  OrchestrationTrace,
  SubtaskResult,
  Tool,
  Usage,
} from "../core/types.js";

/** Executes one generate call. */
export type Runner = (params: GenerateParams) => Promise<GenerateResult>;

export interface ResolvedOrchestrateOptions {
  executor: "inline" | "worker";
  maxConcurrency: number;
  maxSubtasks: number;
  /** Thread count when executor is "worker". */
  workers?: number;
  plannerModel?: string;
  agentModel?: string;
}

/** The planner reports its decision by calling this tool. */
const PLAN_TOOL: Tool = {
  name: "submit_plan",
  description:
    "Report whether the user's request should be split into independent subtasks, and if so, what they are.",
  parameters: {
    type: "object",
    properties: {
      complex: {
        type: "boolean",
        description:
          "True only if the request genuinely benefits from being split into independent parts that can be worked on separately.",
      },
      reasoning: {
        type: "string",
        description: "One sentence explaining the decision.",
      },
      subtasks: {
        type: "array",
        description:
          "The independent subtasks. Empty when complex is false. Each must be self-contained: a sub-agent sees only its own prompt, not the others' work.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Short kebab-case identifier." },
            prompt: {
              type: "string",
              description: "A complete, standalone instruction for one sub-agent.",
            },
          },
          required: ["id", "prompt"],
        },
      },
    },
    required: ["complex", "subtasks"],
  },
};

const PLANNER_SYSTEM =
  "You are a planning agent. Decide whether the user's request should be broken into " +
  "independent subtasks that separate agents can work on in parallel. " +
  "Split only when the parts are genuinely independent and the work is substantial — " +
  "a question answerable in a single response is not complex. Always call submit_plan.";

interface Plan {
  complex: boolean;
  reasoning?: string;
  subtasks: Array<{ id: string; prompt: string }>;
}

/**
 * Run the full orchestration flow.
 *
 * `run` performs planning and synthesis; `runAgent` performs sub-agent calls
 * and may be backed by a worker pool.
 */
export async function orchestrate(
  params: GenerateParams,
  options: ResolvedOrchestrateOptions,
  run: Runner,
  runAgent: Runner = run,
): Promise<GenerateResult> {
  const usageTotal: Usage = { inputTokens: 0, outputTokens: 0 };

  const planResult = await plan(params, options, run);
  addUsage(usageTotal, planResult.usage);

  // Not worth splitting (or the planner declined to answer) — answer directly.
  if (!planResult.plan || !planResult.plan.complex || planResult.plan.subtasks.length === 0) {
    const direct = await run(withoutOrchestration(params));
    addUsage(usageTotal, direct.usage);
    return {
      ...direct,
      usage: usageTotal,
      orchestration: {
        delegated: false,
        reasoning: planResult.plan?.reasoning,
        executor: options.executor,
        subtasks: [],
      },
    };
  }

  const subtasks = planResult.plan.subtasks.slice(0, options.maxSubtasks);

  const results = await mapWithConcurrency(subtasks, options.maxConcurrency, async (task) => {
    try {
      const answer = await runAgent(
        withoutOrchestration({
          ...params,
          model: options.agentModel ?? params.model,
          messages: [{ role: "user", content: task.prompt }],
        }),
      );
      return {
        id: task.id,
        prompt: task.prompt,
        text: answer.text,
        usage: answer.usage,
      } satisfies SubtaskResult;
    } catch (err) {
      // One failed sub-agent must not sink the whole request; synthesis is
      // told which parts are missing.
      return {
        id: task.id,
        prompt: task.prompt,
        text: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        error: err instanceof Error ? err.message : String(err),
      } satisfies SubtaskResult;
    }
  });

  for (const r of results) addUsage(usageTotal, r.usage);

  const final = await run(withoutOrchestration({ ...params, messages: synthesisMessages(params.messages, results) }));
  addUsage(usageTotal, final.usage);

  const trace: OrchestrationTrace = {
    delegated: true,
    reasoning: planResult.plan.reasoning,
    executor: options.executor,
    subtasks: results,
  };

  return { ...final, usage: usageTotal, orchestration: trace };
}

/** Ask the model for a plan via a forced tool call. */
async function plan(
  params: GenerateParams,
  options: ResolvedOrchestrateOptions,
  run: Runner,
): Promise<{ plan?: Plan; usage: Usage }> {
  const result = await run(
    withoutOrchestration({
      ...params,
      model: options.plannerModel ?? params.model,
      messages: [{ role: "system", content: PLANNER_SYSTEM }, ...stripSystem(params.messages)],
      tools: [PLAN_TOOL],
      toolChoice: { name: PLAN_TOOL.name },
    }),
  );

  const call = result.toolCalls.find((c) => c.name === PLAN_TOOL.name);
  if (!call) return { usage: result.usage };

  return { plan: coercePlan(call.arguments), usage: result.usage };
}

/** Models are inconsistent about optional fields; normalize defensively. */
function coercePlan(args: Record<string, unknown>): Plan {
  const rawSubtasks = Array.isArray(args["subtasks"]) ? args["subtasks"] : [];
  const subtasks = rawSubtasks
    .map((t, i) => {
      const obj = (t ?? {}) as Record<string, unknown>;
      const prompt = typeof obj["prompt"] === "string" ? obj["prompt"] : "";
      const id = typeof obj["id"] === "string" && obj["id"] ? obj["id"] : `subtask-${i + 1}`;
      return { id, prompt };
    })
    .filter((t) => t.prompt.length > 0);

  return {
    complex: args["complex"] === true,
    reasoning: typeof args["reasoning"] === "string" ? args["reasoning"] : undefined,
    subtasks,
  };
}

/** Build the synthesis turn: the original ask plus every sub-agent's answer. */
function synthesisMessages(original: Message[], results: SubtaskResult[]): Message[] {
  const findings = results
    .map((r) => {
      const body = r.error ? `(failed: ${r.error})` : r.text;
      return `### ${r.id}\nTask: ${r.prompt}\n\n${body}`;
    })
    .join("\n\n");

  return [
    ...original,
    {
      role: "user",
      content:
        "Sub-agents completed the following parts of this request. " +
        "Use their findings to answer the original request in full. " +
        "Do not mention the sub-agents or this process; note any gaps if a part failed.\n\n" +
        findings,
    },
  ];
}

/** Planner/sub-agent/synthesis calls must never recurse into orchestration. */
function withoutOrchestration(params: GenerateParams): GenerateParams {
  const { orchestrate: _ignored, ...rest } = params;
  return rest;
}

function stripSystem(messages: Message[]): Message[] {
  return messages.filter((m) => m.role !== "system");
}

function addUsage(total: Usage, add: Usage): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
}

/** Run `fn` over items, at most `limit` at a time, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}
