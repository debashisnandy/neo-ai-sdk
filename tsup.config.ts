import { defineConfig } from "tsup";

// Produces the dual ESM/CJS + .d.ts / .d.cts outputs referenced in package.json "exports".
export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Loaded on runtimes that don't match the "node" export condition; see src/unsupported.ts.
    unsupported: "src/unsupported.ts",
  },
  format: ["esm", "cjs"],
  // Declarations are emitted separately by `tsc` (see the "build" script).
  // tsup's built-in dts uses rollup-plugin-dts, which crashes on the native
  // TypeScript 7 compiler API (Cannot read '...useCaseSensitiveFileNames').
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Keep the published bundle dependency-light; declare real deps in package.json instead of inlining them.
  splitting: false,
  target: "node20",
});
