import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "src/**/pi-memory-maintenance.boundary.test.ts",
      "src/**/pi-deferred-handoff.boundary.test.ts",
    ],
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
