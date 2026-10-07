import { defineConfig } from "vitest/config";
import base, { realDatabaseSetupFiles } from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Boundary suites require real DB setup and must not inherit the PGlite project.
    projects: [
      {
        extends: true,
        test: { name: "api-maintenance", setupFiles: realDatabaseSetupFiles },
      },
    ],
    include: ["src/**/pi-deferred-handoff.boundary.test.ts"],
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
