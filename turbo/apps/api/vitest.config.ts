import { defineConfig } from "vitest/config";

const catalogTests = [
  "src/signals/routes/__tests__/official-workflows.test.ts",
  "src/signals/routes/__tests__/official-workflows-schedule-claims.test.ts",
  "src/signals/routes/__tests__/cron-official-workflow-catalog.test.ts",
];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      TZ: "UTC",
    },
    setupFiles: ["./src/__tests__/env-stub.ts", "./src/__tests__/setup.ts"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "**/__benches__/**",
      "**/*.boundary.test.ts",
    ],
    // These suites mutate the same real catalog authority. Vitest owns their
    // scheduling; no database session or production lock is a test resource.
    projects: [
      {
        extends: true,
        test: { name: "api", exclude: catalogTests },
      },
      {
        extends: true,
        test: {
          name: "api-catalog",
          include: catalogTests,
          benchmark: { enabled: false },
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    benchmark: {
      include: ["src/**/__benches__/**/*.bench.ts"],
      retainSamples: true,
    },
  },
});
