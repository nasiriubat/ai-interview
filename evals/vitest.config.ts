import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.eval.ts"], setupFiles: ["../packages/testing/src/network-guard.ts"] },
});
