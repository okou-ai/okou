import { command } from "ccstate";

import { resolveOrgCreditAvailability$ } from "./run-admission.service";

export const checkBillableOperationCredits$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const availability = await set(resolveOrgCreditAvailability$, {
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!availability || availability.status !== "active") {
      return false;
    }
    return (
      availability.usagePackCredits > 0 || availability.spendableCredits > 0
    );
  },
);
