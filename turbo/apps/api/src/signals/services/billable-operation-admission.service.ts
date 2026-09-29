import { command } from "ccstate";

import { resolveUsageAllowanceAvailability$ } from "./usage-allowance-availability.service";
import {
  resolveActiveRunCreditAdmission$,
  resolveOrgCreditAvailability$,
} from "./run-admission.service";

export const checkBillableOperationCredits$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const availability = await set(
      resolveOrgCreditAvailability$,
      {
        orgId: args.orgId,
        userId: args.userId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!availability || availability.status !== "active") {
      return false;
    }
    const activeRunAdmission = await set(
      resolveActiveRunCreditAdmission$,
      {
        runId: args.runId,
        orgId: args.orgId,
        userId: args.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (activeRunAdmission) {
      return true;
    }
    if (
      availability.usagePackCredits > 0 ||
      availability.spendableCredits > 0
    ) {
      return true;
    }

    const allowance = await set(
      resolveUsageAllowanceAvailability$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();
    return (allowance?.remainingUnits ?? 0) > 0;
  },
);
