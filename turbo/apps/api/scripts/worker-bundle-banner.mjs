// Workers' legacy registry does not populate import.meta.url, and exposes
// node:process via ESM but not createRequire(). Return the real runtime object
// only when a dependency requires it: instantiating node:process costs
// measurable Cloudflare startup CPU. Retain native require behavior/properties
// for every other bundled dependency.
export const workerRequireBanner =
  'import { createRequire as __workerCreateRequire } from "node:module"; const __workerNativeRequire = __workerCreateRequire(import.meta.url || "file:///bundle/worker.js"); const require = Object.assign((specifier) => specifier === "node:process" || specifier === "process" ? globalThis.process : __workerNativeRequire(specifier), __workerNativeRequire);';
