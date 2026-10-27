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
const runtimeEnv = Object.freeze({ ...packedEnv, ...process.env });

// Deployments validate their environment before release and publish the
// decoded result; their runtimes never construct the schema. Processes started
// without deployment tooling, such as local servers and tests, validate here.
const validatedEnv = runtimeEnv[VALIDATED_API_ENV];
const baseEnv: ApiEnv = validatedEnv
  ? (JSON.parse(validatedEnv) as ApiEnv)
  : decodeApiEnv(runtimeEnv);

type EnvName = keyof ApiEnv;

const {
  get: getOverrideEnv,
  set: setOverrideEnv,
  clear: clearOverrideEnv,
} = testOverride<Partial<ApiEnv>>(() => {
  return {};
});

const {
  get: getOptionalOverrideEnv,
  set: setOptionalOverrideEnv,
  clear: clearOptionalOverrideEnv,
} = testOverride<Readonly<Record<string, string | undefined>>>(() => {
  return {};
});

export function env<K extends EnvName>(name: K): ApiEnv[K] {
  const overrideEnv = getOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name] as ApiEnv[K];
  }
  return baseEnv[name];
}

export function optionalEnv(name: string): string | undefined {
  const overrideEnv = getOptionalOverrideEnv();
  if (Object.prototype.hasOwnProperty.call(overrideEnv, name)) {
    return overrideEnv[name];
  }
  return process.env[name] || packedEnv[name] || undefined;
}

export function mockEnv<K extends EnvName>(
  name: K,
  value: input<ApiEnvSchema[K]>,
): void {
  const schema = apiEnvSchema()[name] as ZodType;
  setOverrideEnv({
    ...getOverrideEnv(),
    [name]: schema.parse(value) as ApiEnv[K],
  });
}

export function mockOptionalEnv(name: string, value: string | undefined): void {
  setOptionalOverrideEnv({
    ...getOptionalOverrideEnv(),
    [name]: value,
  });
}

export function clearMockedEnv(): void {
  clearOverrideEnv();
  clearOptionalOverrideEnv();
}
