// Workers' legacy module registry does not populate import.meta.url. Keep real
// nodejs_compat require() for bundled CommonJS dependencies without relying on it.
export const workerRequireBanner =
  'import { createRequire as __workerCreateRequire } from "node:module"; const require = __workerCreateRequire(import.meta.url || "file:///bundle/worker.js");';
