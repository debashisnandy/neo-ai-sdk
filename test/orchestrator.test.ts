/**
 * Orchestration tests. The orchestrator takes its runners by injection, so the
 * plan/delegate/synthesize logic is tested directly with no network or workers.
 */

import { describe, expect, it } from "vitest";
import {
  orchestrate,
  mapWithConcurrency,
  type ResolvedOrchestrateOptions,
  type Runner,
} from "../src/orchestrator/orchestrator.js";
import type { GenerateParams, GenerateResult } from "../src/core/types.js";

const OPTIONS: ResolvedOrchestrateOptions = {
  executor: "inline",
  maxConcurrency: 4,
  maxSubtasks: 5,
};

const ASK: GenerateParams = {
  model: "openai/gpt-5",
  messages: [{ role: "user", content: "Compare three databases." }],
};

function result(over: Partial<GenerateResult> = {}): GenerateResult {
  return {
    text: "",
    model: "openai/gpt-5",
    usage: { inputTokens: 1, outputTokens: 1 },
    toolCalls: [],
    finishReason: "stop",
    ...over,
  };
}

/** A planner reply that calls submit_plan with the given arguments. */
function planReply(args: Record<string, unknown>): GenerateResult {
  return result({
    finishReason: "tool_use",
    toolCalls: [{ id: "p1", name: "submit_plan", arguments: args }],
  });
}

/**
 * Scripts a sequence of runner replies and records every call it received.
 * Sub-agent calls are identified by their single user message.
 */
function scriptedRunner(replies: Array<(p: GenerateParams) => GenerateResult>) {
  const calls: GenerateParams[] = [];
  let i = 0;
  const run: Runner = async (params) => {
    calls.push(params);
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return reply(params);
  };
  return { run, calls };
}

describe("orchestrate — planning", () => {
  it("answers directly when the planner says the task is simple", async () => {
    const { run, calls } = scriptedRunner([
      () => planReply({ complex: false, reasoning: "single question", subtasks: [] }),
      () => result({ text: "direct answer" }),
    ]);

    const out = await orchestrate(ASK, OPTIONS, run);

    expect(out.text).toBe("direct answer");
    expect(out.orchestration?.delegated).toBe(false);
    expect(out.orchestration?.reasoning).toBe("single question");
    expect(out.orchestration?.subtasks).toEqual([]);
    expect(calls).toHaveLength(2); // plan + direct answer
  });

  it("forces the planner to call submit_plan", async () => {
    const { run, calls } = scriptedRunner([
      () => planReply({ complex: false, subtasks: [] }),
      () => result({ text: "x" }),
    ]);
    await orchestrate(ASK, OPTIONS, run);

    const planCall = calls[0]!;
    expect(planCall.tools?.[0]?.name).toBe("submit_plan");
    expect(planCall.toolChoice).toEqual({ name: "submit_plan" });
  });

  // A planner that ignores the tool must not strand the request.
  it("falls back to a direct answer when the planner returns no tool call", async () => {
    const { run } = scriptedRunner([
      () => result({ text: "" }),
      () => result({ text: "fallback answer" }),
    ]);

    const out = await orchestrate(ASK, OPTIONS, run);
    expect(out.text).toBe("fallback answer");
    expect(out.orchestration?.delegated).toBe(false);
  });

  it("does not delegate when complex is true but no subtasks were given", async () => {
    const { run } = scriptedRunner([
      () => planReply({ complex: true, subtasks: [] }),
      () => result({ text: "direct" }),
    ]);

    const out = await orchestrate(ASK, OPTIONS, run);
    expect(out.orchestration?.delegated).toBe(false);
  });

  it("never lets planning, sub-agents, or synthesis recurse into orchestration", async () => {
    const { run, calls } = scriptedRunner([
      () => planReply({ complex: true, subtasks: [{ id: "a", prompt: "A" }] }),
      () => result({ text: "sub" }),
      () => result({ text: "final" }),
    ]);

    await orchestrate({ ...ASK, orchestrate: true }, OPTIONS, run);
    for (const call of calls) expect(call.orchestrate).toBeUndefined();
  });
});

describe("orchestrate — delegation", () => {
  const THREE = {
    complex: true,
    reasoning: "three independent comparisons",
    subtasks: [
      { id: "postgres", prompt: "Describe Postgres." },
      { id: "mysql", prompt: "Describe MySQL." },
      { id: "sqlite", prompt: "Describe SQLite." },
    ],
  };

  it("runs one sub-agent per subtask and synthesizes the result", async () => {
    const { run, calls } = scriptedRunner([
      () => planReply(THREE),
      (p) => result({ text: `answer for ${p.messages[0]!.content}` }),
      (p) => result({ text: `answer for ${p.messages[0]!.content}` }),
      (p) => result({ text: `answer for ${p.messages[0]!.content}` }),
      () => result({ text: "synthesized" }),
    ]);

    const out = await orchestrate(ASK, OPTIONS, run);

    expect(out.text).toBe("synthesized");
    expect(out.orchestration?.delegated).toBe(true);
    expect(out.orchestration?.subtasks.map((s) => s.id)).toEqual([
      "postgres",
      "mysql",
      "sqlite",
    ]);
    expect(calls).toHaveLength(5); // plan + 3 agents + synthesis
  });

  it("gives each sub-agent only its own standalone prompt", async () => {
    const { run, calls } = scriptedRunner([
      () => planReply(THREE),
      () => result({ text: "a" }),
      () => result({ text: "b" }),
      () => result({ text: "c" }),
      () => result({ text: "final" }),
    ]);

    await orchestrate(ASK, OPTIONS, run);

    const agentCalls = calls.slice(1, 4);
    expect(agentCalls.map((c) => c.messages)).toEqual([
      [{ role: "user", content: "Describe Postgres." }],
      [{ role: "user", content: "Describe MySQL." }],
      [{ role: "user", content: "Describe SQLite." }],
    ]);
  });

  it("passes every sub-agent's findings into the synthesis turn", async () => {
    const { run, calls } = scriptedRunner([
      () => planReply(THREE),
      () => result({ text: "PG is relational" }),
      () => result({ text: "MySQL is relational" }),
      () => result({ text: "SQLite is embedded" }),
      () => result({ text: "final" }),
    ]);

    await orchestrate(ASK, OPTIONS, run);

    const synthesis = calls[4]!;
    const last = synthesis.messages.at(-1)!.content;
    expect(last).toContain("PG is relational");
    expect(last).toContain("SQLite is embedded");
    // The original request must still be present for context.
    expect(synthesis.messages[0]).toEqual(ASK.messages[0]);
  });

  it("caps subtasks at maxSubtasks", async () => {
    const many = {
      complex: true,
      subtasks: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, prompt: `Task ${i}` })),
    };
    const { run } = scriptedRunner([() => planReply(many), () => result({ text: "x" })]);

    const out = await orchestrate(ASK, { ...OPTIONS, maxSubtasks: 3 }, run);
    expect(out.orchestration?.subtasks).toHaveLength(3);
  });

  it("uses agentModel for sub-agents and plannerModel for planning", async () => {
    const { run, calls } = scriptedRunner([
      () => planReply({ complex: true, subtasks: [{ id: "a", prompt: "A" }] }),
      () => result({ text: "sub" }),
      () => result({ text: "final" }),
    ]);

    await orchestrate(
      ASK,
      { ...OPTIONS, plannerModel: "anthropic/claude-opus-5", agentModel: "openai/gpt-5-mini" },
      run,
    );

    expect(calls[0]!.model).toBe("anthropic/claude-opus-5"); // planner
    expect(calls[1]!.model).toBe("openai/gpt-5-mini"); // sub-agent
  });

  it("sums usage across planning, sub-agents, and synthesis", async () => {
    const { run } = scriptedRunner([
      () => ({ ...planReply(THREE), usage: { inputTokens: 10, outputTokens: 2 } }),
      () => result({ usage: { inputTokens: 5, outputTokens: 5 } }),
      () => result({ usage: { inputTokens: 5, outputTokens: 5 } }),
      () => result({ usage: { inputTokens: 5, outputTokens: 5 } }),
      () => result({ text: "final", usage: { inputTokens: 20, outputTokens: 8 } }),
    ]);

    const out = await orchestrate(ASK, OPTIONS, run);
    // 10+5+5+5+20 in, 2+5+5+5+8 out
    expect(out.usage).toEqual({ inputTokens: 45, outputTokens: 25 });
  });

  it("routes sub-agents through runAgent, keeping planning on the main runner", async () => {
    const main = scriptedRunner([
      () => planReply({ complex: true, subtasks: [{ id: "a", prompt: "A" }] }),
      () => result({ text: "final" }),
    ]);
    const agent = scriptedRunner([() => result({ text: "from agent" })]);

    const out = await orchestrate(ASK, OPTIONS, main.run, agent.run);

    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.messages).toEqual([{ role: "user", content: "A" }]);
    expect(main.calls).toHaveLength(2); // plan + synthesis only
    expect(out.orchestration?.subtasks[0]!.text).toBe("from agent");
  });
});

describe("orchestrate — failure handling", () => {
  it("records a failed sub-agent instead of failing the whole request", async () => {
    let call = 0;
    const run: Runner = async (params) => {
      call++;
      if (call === 1) {
        return planReply({
          complex: true,
          subtasks: [
            { id: "ok", prompt: "A" },
            { id: "bad", prompt: "B" },
          ],
        });
      }
      if (params.messages[0]?.content === "B") throw new Error("provider exploded");
      if (params.messages[0]?.content === "A") return result({ text: "A done" });
      return result({ text: "final" });
    };

    const out = await orchestrate(ASK, OPTIONS, run);

    expect(out.text).toBe("final");
    const [ok, bad] = out.orchestration!.subtasks;
    expect(ok!.text).toBe("A done");
    expect(bad!.error).toBe("provider exploded");
    expect(bad!.text).toBe("");
  });

  it("tells synthesis which subtask failed", async () => {
    const calls: GenerateParams[] = [];
    let call = 0;
    const run: Runner = async (params) => {
      calls.push(params);
      call++;
      if (call === 1) return planReply({ complex: true, subtasks: [{ id: "bad", prompt: "B" }] });
      if (params.messages[0]?.content === "B") throw new Error("boom");
      return result({ text: "final" });
    };

    await orchestrate(ASK, OPTIONS, run);
    expect(calls.at(-1)!.messages.at(-1)!.content).toContain("failed: boom");
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms / 10));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
