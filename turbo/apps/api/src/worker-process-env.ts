import { env } from "cloudflare:workers";

/** nodejs_compat's process.env value for a binding, if it exposes one. */
function processEnvValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const json =
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    (typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype);
  return json ? JSON.stringify(value) : undefined;
}

const bindings: [string, unknown][] = Object.entries(env);

/**
 * Worker-build-only `process.env`, injected by the Worker build's defines.
 * Mirrors nodejs_compat's population from bindings: text bindings verbatim,
 * JSON bindings serialized, resource bindings omitted. Reading it at startup
 * does not instantiate node:process, which costs measurable startup CPU.
 * It stays mutable like process.env; dependencies such as debug write to it.
 */
export const workerProcessEnv: Record<string, string> = Object.fromEntries(
  bindings.flatMap(([name, value]): [string, string][] => {
    const text = processEnvValue(value);
    return text === undefined ? [] : [[name, text]];
  }),
);
