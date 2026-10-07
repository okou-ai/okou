import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    name: "api-run-time-budget",
    include: ["src/**/chat-events-budget-steer.boundary.test.ts"],
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
    fileParallelism: false,
  },
});
