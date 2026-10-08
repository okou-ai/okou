import { z } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";

export const usagePackOverdraftTransferOutcomeRow = z.object({
  has_wallet: z.boolean(),
  negative_grants: pgInt8ToSafeIntegerSchema,
  amount: pgInt8ToSafeIntegerSchema,
});

/** Validate returned values, never pass the executor out of its transaction owner. */
export function requireUsagePackOverdraftTransfer(
  outcomes: readonly z.output<typeof usagePackOverdraftTransferOutcomeRow>[],
) {
  const [outcome] = outcomes;
  if (!outcome) {
    throw new Error("Usage pack overdraft transfer outcome is missing");
  }
  if (!outcome.has_wallet && outcome.negative_grants > 0) {
    throw new Error("Usage pack overdraft has no organization wallet");
  }
}
