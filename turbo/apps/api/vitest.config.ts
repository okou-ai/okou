import { defineConfig } from "vitest/config";
import { apiTestEnvironment } from "./src/__tests__/test-environment";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./src/test-fixtures/worker-runtime-sdk.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    name: "api",
    globals: true,
    // Bound concurrent PGlite initialization and V8 coverage resource use.
    maxWorkers: 2,
    environment: "node",
    env: { ...apiTestEnvironment, TZ: "UTC" },
    globalSetup: ["./src/__tests__/global-setup.ts"],
    setupFiles: [
      "./src/__tests__/env-stub.ts",
      "./src/__tests__/mocks.ts",
      "./src/__tests__/setup.ts",
    ],
    sequence: { setupFiles: "list" },
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
  },
});
