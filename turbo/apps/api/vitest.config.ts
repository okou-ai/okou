import { defineConfig } from "vitest/config";

const catalogTests = [
  "src/signals/routes/__tests__/official-automation-result-email.test.ts",
  "src/signals/routes/__tests__/chat-run-finished-automations.bdd.test.ts",
  "src/signals/routes/__tests__/official-workflows.test.ts",
  "src/signals/routes/__tests__/official-workflows-schedule-claims.test.ts",
  "src/signals/routes/__tests__/cron-official-workflow-catalog.test.ts",
  // Mutate shared catalog authority or the fixed Auto runtime cooldown.
  // Do not overlap ordinary suites that admit Auto runs.
  "src/signals/routes/__tests__/model-catalog.test.ts",
  "src/signals/routes/__tests__/test-runtime-state.test.ts",
];

// PostgreSQL cancellation fixtures temporarily replace Client.prototype.query.
// Keep their owning files and cases serial in an explicitly isolated project.
const bootstrapFailureTests = [
  "src/signals/routes/__tests__/chat-events-bootstrap-prefetch.test.ts",
  "src/signals/routes/__tests__/chat-events-model-source-context.test.ts",
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
        test: {
          name: "api",
          exclude: [...catalogTests, ...bootstrapFailureTests],
        },
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
      {
        extends: true,
        test: {
          name: "api-bootstrap-failure",
          include: bootstrapFailureTests,
          benchmark: { enabled: false },
          isolate: true,
          fileParallelism: false,
          sequence: { groupOrder: 2, concurrent: false },
        },
      },
    ],
    benchmark: {
      include: ["src/**/__benches__/**/*.bench.ts"],
      retainSamples: true,
    },
  },
});
