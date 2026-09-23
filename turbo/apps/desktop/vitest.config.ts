import { defineConfig } from "vitest/config";
import { DurationGuardReporter } from "../../vitest-perf-reporter.ts";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    clearMocks: true,
    reporters: process.env.CI
      ? ["default", new DurationGuardReporter()]
      : ["default"],
  },
});
