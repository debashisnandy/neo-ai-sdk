/**
 * Runs guardrails in order, threading each one's modifications into the next.
 *
 * Ordering is deliberate and stable: guardrails configured on the client run
 * before per-request ones, and within each list, array order is preserved. A
 * redaction guardrail placed first therefore sees raw data, and a validator
 * placed after it sees the redacted version.
 *
 * A denial throws immediately — later guardrails do not run, and for tool calls
 * no further calls are inspected. Blocking should be loud and unambiguous.
 */

import { GuardrailError } from "../core/errors.js";
import type { GenerateParams, GenerateResult, Message, ToolCall } from "../core/types.js";
import type { Guardrail, GuardrailDecision } from "./types.js";

/** Apply one decision to the current value, or throw if it was a denial. */
function apply<T>(
  decision: GuardrailDecision<T>,
  current: T,
  guardrail: string,
  stage: "input" | "toolCall" | "output",
): T {
  if (!decision || decision.action === "allow") return current;
  if (decision.action === "deny") throw new GuardrailError(guardrail, stage, decision.reason);
  return decision.value;
}

/** Run input guardrails, returning the (possibly rewritten) messages. */
export async function runInputGuardrails(
  guardrails: readonly Guardrail[],
  model: string,
  messages: Message[],
  params: Readonly<GenerateParams>,
): Promise<Message[]> {
  let current = messages;
  for (const guardrail of guardrails) {
    if (!guardrail.input) continue;
    const decision = await guardrail.input({ model, messages: current, params });
    current = apply(decision, current, guardrail.name, "input");
  }
  return current;
}

/**
 * Run tool-call guardrails over every requested call.
 *
 * Each call is inspected independently, so one dangerous call is blocked even
 * when the model requested several at once.
 */
export async function runToolCallGuardrails(
  guardrails: readonly Guardrail[],
  model: string,
  toolCalls: ToolCall[],
  params: Readonly<GenerateParams>,
): Promise<ToolCall[]> {
  if (toolCalls.length === 0) return toolCalls;

  const out: ToolCall[] = [];
  for (const original of toolCalls) {
    let current = original;
    for (const guardrail of guardrails) {
      if (!guardrail.toolCall) continue;
      const decision = await guardrail.toolCall({ model, toolCall: current, params });
      current = apply(decision, current, guardrail.name, "toolCall");
    }
    out.push(current);
  }
  return out;
}

/** Run output guardrails, returning the (possibly rewritten) result. */
export async function runOutputGuardrails(
  guardrails: readonly Guardrail[],
  model: string,
  result: GenerateResult,
  params: Readonly<GenerateParams>,
): Promise<GenerateResult> {
  let current = result;
  for (const guardrail of guardrails) {
    if (!guardrail.output) continue;
    const decision = await guardrail.output({ model, result: current, params });
    current = apply(decision, current, guardrail.name, "output");
  }
  return current;
}

/** Client-level guardrails run before per-request ones. */
export function combineGuardrails(
  base: readonly Guardrail[] | undefined,
  extra: readonly Guardrail[] | undefined,
): readonly Guardrail[] {
  if (!base?.length) return extra ?? [];
  if (!extra?.length) return base;
  return [...base, ...extra];
}
