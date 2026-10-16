import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@okouai/wechat-gateway-worker",
    globals: true,
    environment: "node",
  },
});
