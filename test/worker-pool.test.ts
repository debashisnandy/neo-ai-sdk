/**
 * WorkerPool tests. These deliberately use real worker threads against a real
 * local HTTP server — mocking fetch here would test nothing, since the whole
 * point is that the request happens on another thread.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WorkerPool } from "../src/orchestrator/worker-pool.js";
import { NeoError } from "../src/core/errors.js";

let server: http.Server;
let baseURL: string;
const seen: Array<{ url: string; method: string; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method ?? "", body });

      if (req.url === "/boom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "server exploded" } }));
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 200);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-custom": "yes" });
      res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  seen.length = 0;
});

describe("WorkerPool", () => {
  it("performs a request on a worker thread and returns a real Response", async () => {
    const pool = new WorkerPool({ size: 1 });
    try {
      const res = await pool.fetch(`${baseURL}/hello`, { method: "GET", headers: {} });

      expect(res).toBeInstanceOf(Response);
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      // Headers must survive the trip back from the worker.
      expect(res.headers.get("x-custom")).toBe("yes");
      await expect(res.json()).resolves.toEqual({ ok: true, echo: null });
    } finally {
      await pool.close();
    }
  });

  it("forwards method, headers and body", async () => {
    const pool = new WorkerPool({ size: 1 });
    try {
      await pool.fetch(`${baseURL}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hi: "there" }),
      });
      expect(seen[0]).toMatchObject({ url: "/echo", method: "POST" });
      expect(JSON.parse(seen[0]!.body)).toEqual({ hi: "there" });
    } finally {
      await pool.close();
    }
  });

  it("preserves non-2xx responses rather than throwing", async () => {
    const pool = new WorkerPool({ size: 1 });
    try {
      const res = await pool.fetch(`${baseURL}/boom`, { method: "GET" });
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: { message: "server exploded" } });
    } finally {
      await pool.close();
    }
  });

  it("runs many requests concurrently and correlates each reply", async () => {
    const pool = new WorkerPool({ size: 3 });
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          pool
            .fetch(`${baseURL}/n`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ i }),
            })
            .then((r) => r.json() as Promise<{ echo: { i: number } }>),
        ),
      );
      // Every request must get its OWN response back, not another job's.
      expect(results.map((r) => r.echo.i)).toEqual([...Array(12).keys()]);
    } finally {
      await pool.close();
    }
  });

  it("rejects with a network error when the host is unreachable", async () => {
    const pool = new WorkerPool({ size: 1 });
    try {
      // Port 1 is reserved and will refuse the connection.
      await expect(pool.fetch("http://127.0.0.1:1/nope", { method: "GET" })).rejects.toThrow();
    } finally {
      await pool.close();
    }
  });

  it("honors an abort signal without waiting for the worker", async () => {
    const pool = new WorkerPool({ size: 1 });
    try {
      const controller = new AbortController();
      const promise = pool.fetch(`${baseURL}/slow`, {
        method: "GET",
        signal: controller.signal,
      });
      controller.abort();
      await expect(promise).rejects.toBeDefined();
    } finally {
      await pool.close();
    }
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const pool = new WorkerPool({ size: 1 });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        pool.fetch(`${baseURL}/x`, { method: "GET", signal: controller.signal }),
      ).rejects.toBeDefined();
      expect(seen).toHaveLength(0); // never dispatched
    } finally {
      await pool.close();
    }
  });

  it("refuses new work after close, and close is idempotent", async () => {
    const pool = new WorkerPool({ size: 1 });
    await pool.fetch(`${baseURL}/a`, { method: "GET" });
    await pool.close();
    await pool.close(); // must not throw

    await expect(pool.fetch(`${baseURL}/b`, { method: "GET" })).rejects.toBeInstanceOf(NeoError);
  });

  it("creates threads lazily — an unused pool starts none", async () => {
    const pool = new WorkerPool({ size: 4 });
    // Nothing dispatched yet, so close() has no threads to tear down.
    await expect(pool.close()).resolves.toBeUndefined();
  });
});
