/**
 * Structured output: constrain a model to a schema and get back a typed,
 * validated object instead of prose.
 *
 * The SDK stays dependency-free by accepting the Standard Schema interface
 * (https://standardschema.dev) rather than any one library. Zod 3.24+, Valibot
 * and ArkType all implement it, so `parse` is wired to whichever you use.
 *
 * Providers also need JSON Schema to constrain decoding. Schemas that can
 * convert themselves — Zod 4 exposes `.toJSONSchema()` on the instance — are
 * used as-is. For libraries that cannot, pass one explicitly via
 * `fromSchema(schema, jsonSchema)`.
 */

import { NeoError } from "./errors.js";
import type { JSONSchema } from "./types.js";

/**
 * The subset of Standard Schema this SDK uses. Structural, so any conforming
 * library satisfies it without importing anything.
 */
export interface StandardSchemaV1<Output = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
  };
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };

/** A fully-resolved output spec: what the provider needs, plus validation. */
export interface OutputSchema<T = unknown> {
  /** Sent to providers that name the schema. Defaults to "response". */
  name?: string;
  description?: string;
  /** JSON Schema used to constrain the model's decoding. */
  jsonSchema: JSONSchema;
  /** Validates/parses the decoded JSON. Throws on invalid data. */
  parse?: (value: unknown) => T;
}

/** What callers may pass as `output`. */
export type OutputSpec<T = unknown> = OutputSchema<T> | StandardSchemaV1<T>;

/** Infer the object type an OutputSpec produces. */
export type InferOutput<S> =
  S extends StandardSchemaV1<infer T> ? T : S extends OutputSchema<infer T> ? T : unknown;

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return typeof value === "object" && value !== null && "~standard" in value;
}

/**
 * Adapt a Standard Schema (Zod, Valibot, ArkType, …) into an OutputSchema.
 *
 *   import { z } from "zod";
 *   const Recipe = z.object({ name: z.string(), steps: z.array(z.string()) });
 *   fromSchema(Recipe, z.toJSONSchema(Recipe), { name: "recipe" })
 *
 * `jsonSchema` is explicit because Standard Schema has no JSON Schema export;
 * passing it keeps this SDK free of a dependency on any schema library.
 */
export function fromSchema<T>(
  schema: StandardSchemaV1<T>,
  jsonSchema: JSONSchema,
  options: { name?: string; description?: string } = {},
): OutputSchema<T> {
  return {
    name: options.name,
    description: options.description,
    jsonSchema,
    parse: (value) => validateWith(schema, value),
  };
}

/** Run a Standard Schema's validation synchronously, throwing on failure. */
function validateWith<T>(schema: StandardSchemaV1<T>, value: unknown): T {
  const result = schema["~standard"].validate(value);

  if (result instanceof Promise) {
    // Async validation would force generate() to await an unknown library's
    // promise mid-parse; refusing is clearer than silently ignoring issues.
    throw new NeoError(
      "Structured output does not support asynchronous schema validation. " +
        "Use a synchronous schema, or validate the result yourself.",
    );
  }

  if (result.issues) {
    const detail = result.issues
      .map((issue) => {
        const path = (issue.path ?? [])
          .map((p) => (typeof p === "object" && p !== null ? String(p.key) : String(p)))
          .join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new NeoError(`Model output failed schema validation — ${detail}`);
  }

  return result.value;
}

/** Normalize whatever the caller passed into a single OutputSchema. */
export function resolveOutput<T>(spec: OutputSpec<T>): OutputSchema<T> {
  if (!isStandardSchema(spec)) return spec;

  // A bare schema has no JSON Schema attached. Some libraries expose a
  // converter on the instance; otherwise the caller must supply one.
  const maybe = spec as { toJSONSchema?: () => JSONSchema };
  if (typeof maybe.toJSONSchema === "function") {
    return fromSchema(spec, maybe.toJSONSchema());
  }

  throw new NeoError(
    `Cannot derive a JSON Schema from this "${spec["~standard"].vendor}" schema. ` +
      "Pass it explicitly with fromSchema(schema, jsonSchema) — " +
      "for Zod: fromSchema(MySchema, z.toJSONSchema(MySchema)).",
  );
}

/**
 * Turn the model's raw JSON text into a validated object.
 *
 * Failures throw rather than returning undefined: a caller asking for
 * structured output cannot do anything useful with malformed data.
 */
export function parseOutput<T>(output: OutputSchema<T>, raw: string): T {
  const text = raw.trim();
  if (!text) {
    throw new NeoError("Model returned an empty response where structured output was required.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new NeoError(
      `Model returned invalid JSON for structured output: ${truncate(text)}`,
      { cause: err },
    );
  }

  return output.parse ? output.parse(value) : (value as T);
}

/** Apply validation to an already-decoded value (Anthropic's tool path). */
export function validateOutput<T>(output: OutputSchema<T>, value: unknown): T {
  return output.parse ? output.parse(value) : (value as T);
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Provider-facing view of the schema, with defaults applied. */
export function describeSchema(output: OutputSchema): {
  name: string;
  description?: string;
  schema: JSONSchema;
} {
  return {
    name: output.name ?? "response",
    description: output.description,
    schema: output.jsonSchema,
  };
}
