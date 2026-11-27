/**
 * Legacy Vitest per-case timeout ceilings (in milliseconds) for API tests that
 * must dispatch real Runs through public entry points.
 *
 * Ordinary non-Run tests must not specify a timeout and remain strictly <= 200 ms.
 * Never increase these values or add a higher tier; they are temporary legacy
 * ceilings to shrink as production Run latency improves.
 */
export const TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE = 400;
export const TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE = 600;
export const TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE = 800;
export const TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE = 1000;
