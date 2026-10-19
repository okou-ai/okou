import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@okouai/link-approval-worker",
    globals: true,
    environment: "node",
  },
});
