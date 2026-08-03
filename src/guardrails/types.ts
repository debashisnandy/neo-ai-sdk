/**
 * Guardrails — validation and transformation around a model call.
 *
 * A guardrail can hook three points, each with different powers:
 *
 *   input    — before the request is sent. Reject bad requests, or rewrite
 *              messages (e.g. strip secrets before they leave the process).
 *   toolCall — for each tool the model asks to call. Block dangerous calls,
 *              sanitize arguments, or await human approval.
 *   output   — after the response. Validate it, or redact what came back.
 *
 * Every hook is optional and may be async, so approval flows and remote policy
 * checks work without a separate mechanism.
 */

import type { GenerateParams, GenerateResult, Message, ToolCall } from "../core/types.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * What a guardrail decided.
 *
 * Returning nothing means "allow" — the common case stays quiet:
 *   input: ({ messages }) => { if (tooLong(messages)) return deny("too long"); }
 */
export type GuardrailDecision<T> =
  | void
  | undefined
  | { action: "allow" }
  | { action: "modify"; value: T }
  | { action: "deny"; reason: string };

export interface InputContext {
  /** The "<company>/<model>" id this request targets. */
  model: string;
  /** Messages as they stand after earlier guardrails have run. */
  messages: Message[];
  /** The rest of the request, for context. Treat as read-only. */
  params: Readonly<GenerateParams>;
}

export interface ToolCallContext {
  model: string;
  /** The call as it stands after earlier guardrails have run. */
  toolCall: ToolCall;
  params: Readonly<GenerateParams>;
}

export interface OutputContext {
  model: string;
  /** The result as it stands after earlier guardrails have run. */
  result: GenerateResult;
  params: Readonly<GenerateParams>;
}

export interface Guardrail {
  /** Identifies the guardrail in errors and logs. */
  name: string;
  input?(ctx: InputContext): MaybePromise<GuardrailDecision<Message[]>>;
  toolCall?(ctx: ToolCallContext): MaybePromise<GuardrailDecision<ToolCall>>;
  output?(ctx: OutputContext): MaybePromise<GuardrailDecision<GenerateResult>>;
}

/** Deny with a reason. Shorthand for `{ action: "deny", reason }`. */
export function deny(reason: string): { action: "deny"; reason: string } {
  return { action: "deny", reason };
}

/** Replace the value under inspection. Shorthand for `{ action: "modify", value }`. */
export function modify<T>(value: T): { action: "modify"; value: T } {
  return { action: "modify", value };
}
