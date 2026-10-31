import { Script, createContext } from "node:vm";

export function compileScript(javascript, filename = "app-contracts.iife.js") {
  return new Script(javascript, { filename });
}

export function evaluateScript(script, instrumented = false) {
  // Identical host-backed browser primitives for both variants. Nothing is imported
  // inside the timed path; the IIFE creates all module-local state in this realm.
  const sandbox = {
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    Blob,
    FormData,
    AbortController,
    AbortSignal,
    atob,
    btoa,
  };
  if (instrumented) {
    sandbox.__contractsBenchmarkConstruction = [];
    sandbox.__contractsBenchmarkSeen = new WeakSet();
    sandbox.__contractsBenchmarkInitInvocations = 0;
  }
  const context = createContext(sandbox);
  script.runInContext(context);
  return {
    values: sandbox.__contractsBenchmarkRetained,
    construction: sandbox.__contractsBenchmarkConstruction,
    initInvocations: sandbox.__contractsBenchmarkInitInvocations,
  };
}

export function evaluate(javascript, instrumented = false) {
  return evaluateScript(compileScript(javascript), instrumented);
}

export function verifyRetained(values, expected) {
  if (
    !Array.isArray(values) ||
    values.length !== expected ||
    values.some((value) => {
      return value === undefined;
    })
  )
    throw new Error(
      `Expected ${expected} live runtime bindings, got ${values?.length ?? "no retained array"}.`,
    );
}
