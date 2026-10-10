import { z } from "zod";

/**
 * Dependency-leaf runner values shared by browser, worker, and server
 * contracts. Keep this module independent of the full runner route graph.
 */
export const CANONICAL_GUEST_HOME_DIR = "/home/user";
/** Token kind only; possession of this prefix is never authentication. */
export const OFFICIAL_RUNNER_TOKEN_PREFIX = "vm0_official_";
export const CANONICAL_WORKING_DIR = `${CANONICAL_GUEST_HOME_DIR}/workspace`;

/**
 * Sandbox reuse outcome. One enum value per code branch in the runner's
 * reuse-decision block. `reused` means the sandbox was unparked from the idle
 * pool; the remaining variants describe why reuse did not happen.
 *
 * `featureDisabled` is legacy: written by older runners while reuse was gated
 * by the `sandboxReuse` feature flag (removed when reuse went to full rollout
 * in #10744). Retained here so historical `agent_runs.sandbox_reuse_result`
 * rows still parse on read. The runner no longer emits it.
 *
 * `noSessionId` is also legacy: preceding runners use it for multiple causes,
 * so historical rows cannot identify the exact non-reuse reason.
 */
export const sandboxReuseResultSchema = z.enum([
  "reused",
  "featureDisabled",
  "noSessionId",
  "noReuseKey",
  "poolMiss",
  "profileMismatch",
  "deviceLimitMismatch",
  "unparkFailed",
]);

export type SandboxReuseResult = z.infer<typeof sandboxReuseResultSchema>;

/** Final home reuse outcome after sandbox preparation has settled. */
export const homeReuseResultSchema = z.enum([
  "reused",
  "sandboxReused",
  "cacheMiss",
  "noReuseKey",
  "invalidWorkingDir",
  "lockBusy",
  "invalidMetadata",
  "diskPressure",
  "notConfigured",
  "sandboxPrepareFallback",
]);

export type HomeReuseResult = z.infer<typeof homeReuseResultSchema>;

export const runnerHeartbeatGenerationSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const RUNNER_HOSTNAME_MAX_LENGTH = 255;
export const RUNNER_VERSION_MAX_LENGTH = 128;
export const runnerHostnameSchema = z
  .string()
  .min(1)
  .max(RUNNER_HOSTNAME_MAX_LENGTH);
export const runnerVersionSchema = z
  .string()
  .min(1)
  .max(RUNNER_VERSION_MAX_LENGTH);

/** Runner group format: vm0/<name> (for example, "vm0/production"). */
export const runnerGroupSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+\/[a-z0-9-]+$/,
    "Runner group must be in vm0/<name> format (e.g., vm0/production)",
  );
