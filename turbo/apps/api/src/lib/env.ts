import type { input, ZodType } from "zod";

import {
  apiEnvSchema,
  decodeApiEnv,
  VALIDATED_API_ENV,
  type ApiEnv,
  type ApiEnvSchema,
} from "./env-schema";
import { testOverride } from "./singleton";

// Workers deploy encrypted configuration in bounded chunks rather than one
// binding per setting. Explicit process variables retain Node/local precedence.
function unpackWorkerEnv(): Readonly<Record<string, string>> {
  const configParts = process.env.API_ENV_JSON_PARTS;
  if (!configParts) {
    return {};
  }
  const count = Number(configParts);
  if (!Number.isInteger(count) || count < 1 || count > 126) {
    throw new Error("API_ENV_JSON_PARTS must be an integer from 1 to 126");
  }
  const packed: unknown = JSON.parse(
    Array.from({ length: count }, (_, index) => {
      const part = process.env[`API_ENV_JSON_${index}`];
      if (part === undefined) {
        throw new Error(`API_ENV_JSON_${index} is missing`);
      }
      return part;
    }).join(""),
  );
  if (
    typeof packed !== "object" ||
    packed === null ||
    Array.isArray(packed) ||
    Object.values(packed).some((value) => {
      return typeof value !== "string";
    })
  ) {
    throw new Error("API_ENV_JSON must encode an object of strings");
  }
  return packed as Record<string, string>;
}

const packedEnv = Object.freeze(unpackWorkerEnv());
const processEnv = Object.freeze({ ...process.env });
const runtimeEnv = Object.freeze({ ...packedEnv, ...processEnv });

// Deployments validate their environment before release and publish the
// decoded result; their runtimes never construct the schema. Processes started
// without deployment tooling, such as local servers and tests, validate here.
const validatedEnv = runtimeEnv[VALIDATED_API_ENV];
const baseEnv: ApiEnv = validatedEnv
  ? (JSON.parse(validatedEnv) as ApiEnv)
  : decodeApiEnv(runtimeEnv);

type EnvName = keyof ApiEnv;

interface EnvironmentScope {
  readonly overrides: Partial<ApiEnv>;
  readonly optionalOverrides: Readonly<Record<string, string | undefined>>;
}

const environmentScope = testOverride<EnvironmentScope>(() => {
  return { overrides: {}, optionalOverrides: {} };
});

export function env<K extends EnvName>(name: K): ApiEnv[K] {
  const overrideEnv = environmentScope.get().overrides;
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name] as ApiEnv[K];
  }
  return baseEnv[name];
}

export function optionalEnv(name: string): string | undefined {
  const overrideEnv = environmentScope.get().optionalOverrides;
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name];
  }
  return processEnv[name] || packedEnv[name] || undefined;
}

/** Lazily derive synchronous values from fixed instance configuration. */
export function envSingleton<T>(factory: () => T): () => T {
  const instances = new WeakMap<EnvironmentScope, { readonly value: T }>();
  return () => {
    const scope = environmentScope.get();
    let instance = instances.get(scope);
    if (!instance) {
      instance = { value: factory() };
      instances.set(scope, instance);
    }
    return instance.value;
  };
}

export function mockEnv<K extends EnvName>(
  name: K,
  value: input<ApiEnvSchema[K]>,
): void {
  const schema = apiEnvSchema()[name] as ZodType;
  const parsed = schema.parse(value) as ApiEnv[K];
  const current = environmentScope.get();
  environmentScope.set({
    ...current,
    overrides: { ...current.overrides, [name]: parsed },
  });
}

export function mockOptionalEnv(name: string, value: string | undefined): void {
  const current = environmentScope.get();
  environmentScope.set({
    ...current,
    optionalOverrides: { ...current.optionalOverrides, [name]: value },
  });
}

export function clearMockedEnv(): void {
  environmentScope.clear();
}
