import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@okouai/discord-gateway-worker",
    globals: true,
    environment: "node",
  },
});
