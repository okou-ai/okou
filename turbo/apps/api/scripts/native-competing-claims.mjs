import { fileURLToPath, URL } from "node:url";
import { startVitest } from "vitest/node";

// Native execution has an explicit selection and budget; ordinary API CI keeps
// its existing test selection, timeout, workers and centralized setup unchanged.
const root = fileURLToPath(new URL("..", import.meta.url));
const entry = "src/signals/routes/__tests__/runners-competing-claims.native.ts";
const runner = await startVitest("test", [entry], {
  root,
  config: `${root}/vitest.config.ts`,
  include: [entry],
  watch: false,
  testTimeout: 1_650_000,
});
if (!runner) {
  throw new Error("Native API test runner did not start");
}
await runner.close();
