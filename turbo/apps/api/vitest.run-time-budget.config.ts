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
        test: {
          name: "api-run-time-budget",
          setupFiles: realDatabaseSetupFiles,
        },
      },
    ],
    include: ["src/**/chat-events-budget-steer.boundary.test.ts"],
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
    fileParallelism: false,
  },
});
