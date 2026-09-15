import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "@okouai/media-worker",
    include: ["src/__tests__/*.test.ts"],
    testTimeout: 15000,
  },
});
