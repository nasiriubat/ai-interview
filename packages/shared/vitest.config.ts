import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], setupFiles: ["../testing/src/network-guard.ts"] },
});
