import { command, computed } from "ccstate";

import { testOverride } from "../lib/singleton";

/**
 * Fixed schema ceiling for any stored autonomy budget. It matches the
 * `0..32` CHECK constraints on runs and Automations, so catalog validation
 * and system defaults stay on it regardless of the delegation limit.
 */
export const AUTONOMY_BUDGET_CEILING = 32;

const maxAutonomyBudget = testOverride<number>(() => {
  return AUTONOMY_BUDGET_CEILING;
});

/**
 * Budget granted to the root of a user-started delegation chain: Web and
 * channel inputs and user-created Automations. Production always reads the
 * ceiling; no API, configuration or environment value can change it.
 */
export const maxAutonomyBudget$ = computed(() => {
  return maxAutonomyBudget.get();
});

/**
 * Ethan-approved test control (#37440): lets API tests drive the real
 * delegation chain with a tiny limit instead of 32 hops. `undefined` restores
 * the production default; test context does so after every case.
 */
export const updateMaxAutonomyBudgetForTest$ = command(
  (_, limit: number | undefined) => {
    if (limit === undefined) {
      maxAutonomyBudget.clear();
      return;
    }
    if (
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > AUTONOMY_BUDGET_CEILING
    ) {
      throw new Error(
        `Autonomy budget limit must be an integer from 0 to ${AUTONOMY_BUDGET_CEILING}`,
      );
    }
    maxAutonomyBudget.set(limit);
  },
);
