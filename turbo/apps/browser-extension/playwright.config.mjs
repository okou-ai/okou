import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: "list",
  outputDir: "test-results/okou-browser",
});
