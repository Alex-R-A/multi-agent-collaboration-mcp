import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.mjs"],
    exclude: ["test/run-suite.mjs", "test/persona-helpers.mjs"],
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["test/**/*.mjs"],
      clean: true,
      all: true,
    },
  },
});
