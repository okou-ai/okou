// Workers' legacy registry does not populate import.meta.url, and exposes
// node:process via ESM but not createRequire(). Retain the real runtime object
// and native require behavior/properties for every other bundled dependency.
export const workerRequireBanner =
  'import { createRequire as __workerCreateRequire } from "node:module"; import __workerProcess from "node:process"; const __workerNativeRequire = __workerCreateRequire(import.meta.url || "file:///bundle/worker.js"); const require = Object.assign((specifier) => specifier === "node:process" || specifier === "process" ? __workerProcess : __workerNativeRequire(specifier), __workerNativeRequire);';
