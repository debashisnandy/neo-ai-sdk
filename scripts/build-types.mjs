/**
 * Emit declarations for both module systems.
 *
 * Why two trees instead of copying index.d.ts to index.d.cts: a .d.cts file
 * whose relative imports ("./client.js") resolve to ESM .d.ts files is a type
 * error (TS1479) for consumers on node16/nodenext resolution. Emitting a second
 * tree under dist/cjs/ with its own {"type":"commonjs"} marker makes every file
 * in that subtree CJS, so relative imports resolve CJS -> CJS.
 *
 * Also replaces the previous `cp`, which was Unix-only.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
const run = (args) =>
  execFileSync(join("node_modules", ".bin", tsc), args, { stdio: "inherit" });

// ESM declarations -> dist/ (root package.json already says "type": "module").
run(["--emitDeclarationOnly"]);

// CJS declarations -> dist/cjs/
run(["--emitDeclarationOnly", "--outDir", "dist/cjs"]);
writeFileSync(join("dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");

console.log("declarations: dist/ (esm) + dist/cjs/ (cjs)");
