/**
 * Ready-made guardrails for the common cases. Each is a plain factory
 * returning a Guardrail, so they compose with your own in one array.
 */

import type { GenerateResult, Message, ToolCall } from "../core/types.js";
import type { Guardrail, MaybePromise } from "./types.js";
import { deny, modify } from "./types.js";

// ---------------------------------------------------------------- input ---

/** Reject requests whose combined message text exceeds `maxChars`. */
export function maxInputLength(maxChars: number, name = "max-input-length"): Guardrail {
  return {
    name,
    input({ messages }) {
      const total = messages.reduce((sum, m) => sum + m.content.length, 0);
      if (total > maxChars) {
        return deny(`input is ${total} characters, limit is ${maxChars}`);
      }
    },
  };
}

/**
 * Reject requests whose text matches any pattern — prompt-injection markers,
 * banned topics, internal codenames that must not reach a provider.
 */
export function blockInputPatterns(options: {
  patterns: RegExp[];
  reason?: string;
  name?: string;
}): Guardrail {
  const { patterns, reason = "input matched a blocked pattern" } = options;
  return {
    name: options.name ?? "block-input-patterns",
    input({ messages }) {
      for (const message of messages) {
        for (const pattern of patterns) {
          if (matches(pattern, message.content)) {
            return deny(`${reason} (${pattern})`);
          }
        }
      }
    },
  };
}

// ------------------------------------------------------------ tool calls ---

/** Block specific tools outright. */
export function denyTools(names: string[], name = "deny-tools"): Guardrail {
  const blocked = new Set(names);
  return {
    name,
    toolCall({ toolCall }) {
      if (blocked.has(toolCall.name)) {
        return deny(`tool "${toolCall.name}" is not permitted`);
      }
    },
  };
}

/**
 * Allow only the listed tools. Safer than denyTools when new tools may appear:
 * anything unrecognized is refused rather than silently permitted.
 */
export function allowTools(names: string[], name = "allow-tools"): Guardrail {
  const allowed = new Set(names);
  return {
    name,
    toolCall({ toolCall }) {
      if (!allowed.has(toolCall.name)) {
        return deny(`tool "${toolCall.name}" is not on the allow list`);
      }
    },
  };
}

/**
 * Human-in-the-loop approval for risky tool calls.
 *
 * `approve` may be async — prompt a user, post to Slack, check a policy
 * service. Returning false denies the call.
 *
 *   requireApproval({
 *     tools: ["delete_records", "send_email"],
 *     approve: async (call) => askOperator(call),
 *   })
 *
 * Omit `tools` to require approval for every call.
 */
export function requireApproval(options: {
  approve: (toolCall: ToolCall) => MaybePromise<boolean>;
  tools?: string[];
  reason?: string;
  name?: string;
}): Guardrail {
  const gated = options.tools ? new Set(options.tools) : undefined;
  return {
    name: options.name ?? "require-approval",
    async toolCall({ toolCall }) {
      if (gated && !gated.has(toolCall.name)) return;
      const approved = await options.approve(toolCall);
      if (!approved) {
        return deny(options.reason ?? `approval denied for "${toolCall.name}"`);
      }
    },
  };
}

/** Reject tool calls whose arguments match a pattern (e.g. `DROP TABLE`). */
export function blockToolArguments(options: {
  patterns: RegExp[];
  tools?: string[];
  reason?: string;
  name?: string;
}): Guardrail {
  const scoped = options.tools ? new Set(options.tools) : undefined;
  return {
    name: options.name ?? "block-tool-arguments",
    toolCall({ toolCall }) {
      if (scoped && !scoped.has(toolCall.name)) return;
      const serialized = JSON.stringify(toolCall.arguments);
      for (const pattern of options.patterns) {
        if (matches(pattern, serialized)) {
          return deny(
            options.reason ?? `arguments for "${toolCall.name}" matched ${pattern}`,
          );
        }
      }
    },
  };
}

// --------------------------------------------------------------- output ---

/**
 * Validate the response. Return a string to reject with that reason, or
 * nothing to accept.
 *
 *   validateOutput({ check: (r) => r.text.length < 10 ? "too short" : undefined })
 */
export function validateOutput(options: {
  check: (result: GenerateResult) => MaybePromise<string | void | undefined>;
  name?: string;
}): Guardrail {
  return {
    name: options.name ?? "validate-output",
    async output({ result }) {
      const problem = await options.check(result);
      if (problem) return deny(problem);
    },
  };
}

// -------------------------------------------------------------- redaction ---

/** Patterns for commonly sensitive values. Deliberately conservative. */
export const SENSITIVE_PATTERNS: Record<string, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.]+/g,
  // 13–16 digits, optionally separated — catches most card numbers.
  creditCard: /\b(?:\d[ -]?){13,16}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  // Common API-key shapes: sk-…, ghp_…, AKIA…
  apiKey: /\b(?:sk-[A-Za-z0-9-_]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
};

/**
 * Remove sensitive information from what goes out, what comes back, or both.
 *
 *   redact({ stages: ["input"] })                    // never send secrets
 *   redact({ patterns: [/internal-\d+/g] })          // custom
 *
 * Defaults to every pattern in SENSITIVE_PATTERNS, on both stages.
 * Redaction rewrites rather than rejects — the request still proceeds.
 */
export function redact(options: {
  patterns?: RegExp[];
  replacement?: string;
  stages?: Array<"input" | "output">;
  name?: string;
} = {}): Guardrail {
  const patterns = options.patterns ?? Object.values(SENSITIVE_PATTERNS);
  const replacement = options.replacement ?? "[REDACTED]";
  const stages = new Set(options.stages ?? ["input", "output"]);

  const scrub = (text: string): string =>
    patterns.reduce((acc, pattern) => acc.replace(global(pattern), replacement), text);

  const guardrail: Guardrail = { name: options.name ?? "redact" };

  if (stages.has("input")) {
    guardrail.input = ({ messages }) => {
      const cleaned: Message[] = messages.map((m) => {
        const content = scrub(m.content);
        return content === m.content ? m : { ...m, content };
      });
      return cleaned.some((m, i) => m !== messages[i]) ? modify(cleaned) : undefined;
    };
  }

  if (stages.has("output")) {
    guardrail.output = ({ result }) => {
      const text = scrub(result.text);
      // Structured output must be scrubbed too, or redaction is trivially
      // bypassed by asking for JSON.
      const object = result.object === undefined ? undefined : scrubDeep(result.object, scrub);
      if (text === result.text && object === result.object) return;
      return modify({ ...result, text, ...(object !== undefined ? { object } : {}) });
    };
  }

  return guardrail;
}

/** Recursively scrub strings inside an arbitrary decoded JSON value. */
function scrubDeep(value: unknown, scrub: (s: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, scrub);
    return out;
  }
  return value;
}

// --------------------------------------------------------------- helpers ---

/** Test without mutating a caller's global regex (lastIndex is stateful). */
function matches(pattern: RegExp, text: string): boolean {
  return global(pattern).test(text);
}

/** A fresh global copy, so reuse across calls never depends on lastIndex. */
function global(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}
