import { optionalEnv } from "../lib/env";

const ciEnv = optionalEnv("CI");
const CI_TIMEOUT_MULTIPLIER =
  ciEnv !== undefined && ciEnv !== "" && ciEnv !== "false" && ciEnv !== "0"
    ? 3
    : 1;

/**
 * Legacy Vitest per-case timeout ceilings (in milliseconds) for API tests that
 * must dispatch real Runs through public entry points.
 *
 * Local runs enforce strict baseline ceilings (400 / 600 / 800 / 1000 ms).
 * CI runs apply a 3x grace multiplier (1200 / 1800 / 2400 / 3000 ms) to absorb
 * runner scheduling variance while keeping local measurement discipline intact.
 *
 * Ordinary non-Run tests must not specify a timeout and remain strictly <= 200 ms.
 * Never increase these baseline values, raise the CI multiplier, or add a higher
 * tier; they are temporary legacy ceilings to shrink as production Run latency
 * improves.
 */
export const TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE =
  400 * CI_TIMEOUT_MULTIPLIER;
export const TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE =
  600 * CI_TIMEOUT_MULTIPLIER;
export const TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE =
  800 * CI_TIMEOUT_MULTIPLIER;
export const TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE =
  1000 * CI_TIMEOUT_MULTIPLIER;
