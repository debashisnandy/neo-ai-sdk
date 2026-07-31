/**
 * Provider abstraction. A Provider knows how to translate the SDK's
 * normalized types into one backend's wire format and back.
 *
 * The NeoClient talks only to this interface, so adding a new backend means
 * writing one file that implements Provider — no changes to client logic.
 */

import type { GenerateParams, GenerateResult, StreamChunk } from "../core/types.js";

export interface Provider {
  /** Stable id, e.g. "neo" | "openai" | "anthropic". */
  readonly name: string;

  /** One-shot generation. */
  generate(params: GenerateParams): Promise<GenerateResult>;

  /** Streaming generation. */
  stream(params: GenerateParams): AsyncIterable<StreamChunk>;
}
