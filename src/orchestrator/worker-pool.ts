/**
 * A small pool of Node worker threads that perform HTTP requests off the main
 * thread, exposed as a drop-in replacement for `fetch`.
 *
 * Why a fetch-shaped interface: Transport already funnels every provider's I/O
 * through one call, so swapping that one function moves all provider traffic
 * onto workers without touching any provider code.
 *
 * What this actually buys you: the network wait itself is not CPU work, so a
 * plain Promise already parallelizes it. The real win is that response decoding
 * (JSON.parse of a large payload) happens off the main thread, and that a
 * misbehaving request cannot block the event loop. If your sub-agents return
 * small responses, the "inline" executor will be faster — measure before
 * choosing this.
 */

import { Worker } from "node:worker_threads";
import { NeoError } from "../core/errors.js";
import type { FetchLike } from "../core/http.js";

/**
 * Worker source, embedded as a string and run with `eval: true`.
 *
 * Deliberately not a separate file: a bundled SDK (ESM, CJS, or inside a
 * consumer's bundler) cannot reliably resolve a sibling worker file at runtime.
 * A self-contained string has no resolution problem and no dependencies.
 */
const WORKER_SOURCE = /* js */ `
const { parentPort } = require("node:worker_threads");

parentPort.on("message", async (job) => {
  try {
    const res = await fetch(job.url, job.init);
    // Read and decode here, on the worker, so the parent never parses it.
    const body = await res.text();
    const headers = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    parentPort.postMessage({ id: job.id, ok: true, status: res.status, headers, body });
  } catch (err) {
    parentPort.postMessage({
      id: job.id,
      ok: false,
      error: (err && err.message) ? err.message : String(err),
      name: (err && err.name) ? err.name : "Error",
    });
  }
});
`;

interface WorkerReply {
  id: number;
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  name?: string;
}

interface Pending {
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
}

export interface WorkerPoolOptions {
  /** Number of threads. Defaults to 2. */
  size?: number;
}

export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly size: number;
  private nextId = 0;
  private nextWorker = 0;
  private closed = false;

  constructor(options: WorkerPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? 2);
  }

  /** A fetch-compatible function that runs the request on a worker thread. */
  readonly fetch: FetchLike = (url, init) => this.run(url, init);

  private run(url: string, init: RequestInit): Promise<Response> {
    if (this.closed) {
      return Promise.reject(new NeoError("WorkerPool has been closed"));
    }

    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));

    const id = this.nextId++;
    const worker = this.workerFor(id);

    return new Promise<Response>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      // AbortSignal cannot cross the worker boundary, so honor it here. The
      // worker's request keeps running; we simply stop waiting for it.
      const onAbort = () => {
        if (this.pending.delete(id)) reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      worker.postMessage({
        id,
        url,
        // Only serializable fields survive the structured clone.
        init: { method: init.method, headers: init.headers, body: init.body },
      });
    });
  }

  /** Round-robin, creating threads lazily so an unused pool costs nothing. */
  private workerFor(id: number): Worker {
    const index = this.nextWorker++ % this.size;
    const existing = this.workers[index];
    if (existing) return existing;

    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.unref(); // never hold the process open
    worker.on("message", (reply: WorkerReply) => this.settle(reply));
    worker.on("error", (err) => this.failAll(err));
    this.workers[index] = worker;
    void id;
    return worker;
  }

  private settle(reply: WorkerReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) return; // already aborted
    this.pending.delete(reply.id);

    if (!reply.ok) {
      const err = new Error(reply.error ?? "worker request failed");
      err.name = reply.name ?? "Error";
      entry.reject(err);
      return;
    }

    // Rebuild a real Response so Transport's existing handling is unchanged.
    entry.resolve(
      new Response(reply.body ?? "", {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
      }),
    );
  }

  /** A thread-level failure can't be attributed to one job, so fail them all. */
  private failAll(err: unknown): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  /** Terminate every thread. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new NeoError("WorkerPool closed while requests were in flight"));
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
  }
}
