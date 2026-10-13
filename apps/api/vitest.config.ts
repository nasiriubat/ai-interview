import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    setupFiles: ["../../packages/testing/src/network-guard.ts"],
  },
});
