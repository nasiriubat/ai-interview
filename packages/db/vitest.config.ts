import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    setupFiles: ["../testing/src/network-guard.ts"],
  },
});
