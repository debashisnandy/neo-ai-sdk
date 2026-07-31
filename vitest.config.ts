import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["src/**/*.ts"],
      // Pure re-export barrel and a runtime guard that throws on import.
      exclude: ["src/index.ts", "src/unsupported.ts"],
    },
  },
});
