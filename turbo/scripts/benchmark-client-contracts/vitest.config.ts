import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    environment: "node",
    globals: false,
    maxWorkers: 1,
    fileParallelism: false,
    benchmark: {
      include: ["scripts/benchmark-client-contracts/cold-evaluation.bench.ts"],
      retainSamples: true,
    },
  },
});
