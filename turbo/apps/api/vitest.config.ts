import { defineConfig } from "vitest/config";

const immutableCatalogTests = [
  "src/signals/routes/__tests__/connector-catalog-immutable.test.ts",
];

const catalogTests = [
  "src/signals/routes/__tests__/official-workflows.test.ts",
  "src/signals/routes/__tests__/official-workflows-schedule-claims.test.ts",
  "src/signals/routes/__tests__/cron-official-workflow-catalog.test.ts",
  // Switches the global model catalog system default, which org policy
  // writes project away; it must not overlap other suites' policy writes.
  "src/signals/routes/__tests__/model-catalog.test.ts",
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
        // Do not inherit setupFiles: Vitest merges inherited arrays rather than
        // replacing them with [], which would open the shared real database.
        test: {
          name: "api-immutable-catalog",
          globals: true,
          environment: "node",
          env: { TZ: "UTC" },
          include: immutableCatalogTests,
          setupFiles: [],
          benchmark: { enabled: false, include: [], exclude: ["**/*"] },
        },
      },
      {
        extends: true,
        test: {
          name: "api",
          exclude: [
            ...catalogTests,
            ...bootstrapFailureTests,
            ...immutableCatalogTests,
          ],
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
