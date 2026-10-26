import { boolean, object, type output } from "zod";

import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";

export const usagePackOverdraftTransferOutcomeRow = object({
  has_wallet: boolean(),
  negative_grants: pgInt8ToSafeIntegerSchema,
  amount: pgInt8ToSafeIntegerSchema,
});

/** Validate returned values, never pass the executor out of its transaction owner. */
export function requireUsagePackOverdraftTransfer(
  outcomes: readonly output<typeof usagePackOverdraftTransferOutcomeRow>[],
) {
  const [outcome] = outcomes;
  if (!outcome) {
    throw new Error("Usage pack overdraft transfer outcome is missing");
  }
  if (!outcome.has_wallet && outcome.negative_grants > 0) {
    throw new Error("Usage pack overdraft has no organization wallet");
  }
}
