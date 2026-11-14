import { number, object, string, uuid, enum as zEnum } from "zod";
import { DEFAULT_PROFILE, executionContextSchema } from "./runners";
import { runnerHeartbeatGenerationSchema } from "./runner-primitives";

/** Complete-input ingress limits shared with the process-owned receiver. */
export const RUNNER_DISPATCH_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const RUNNER_DISPATCH_MAX_VALIDITY_MS = 60_000;

export const DEFAULT_RUNNER_PROFILE = DEFAULT_PROFILE;
export const DEFAULT_RUNNER_PROFILE_VCPU = 2;
export const DEFAULT_RUNNER_PROFILE_MEMORY_MB = 4096;
export const DEFAULT_RUNNER_PROFILE_ROOTFS_DISK_MB = 12288;
export const DEFAULT_RUNNER_PROFILE_HOME_DISK_MB = 24576;

export const runnerDispatchEnvelopeSchema = object({
  runnerId: uuid(),
  heartbeatGeneration: runnerHeartbeatGenerationSchema,
  profile: string(),
  notAfter: number().int().nonnegative(),
  executionContext: executionContextSchema,
}).strict();

export const runnerDispatchResponseSchema = object({
  runnerId: uuid(),
  heartbeatGeneration: runnerHeartbeatGenerationSchema,
  runId: uuid(),
  disposition: zEnum([
    "busy",
    "pending",
    "accepted",
    "rejected",
    "unknown",
    "conflict",
  ]),
}).strict();

/** Same canonical DNS host accepted by official native ingress startup. */
export function isCanonicalRunnerHostname(value: string): boolean {
  const labels = value.split(".");
  return (
    value.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => {
      return (
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      );
    }) &&
    /^[a-z]/.test(labels.at(-1) ?? "") &&
    ![
      "localhost",
      "local",
      "internal",
      "home.arpa",
      "invalid",
      "test",
      "example",
    ].some((suffix) => {
      return value === suffix || value.endsWith(`.${suffix}`);
    })
  );
}
