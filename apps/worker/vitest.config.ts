import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Handler suites with a database share one schema; files run one at a time.
    fileParallelism: false,
    setupFiles: ["../../packages/testing/src/network-guard.ts"],
  },
});
