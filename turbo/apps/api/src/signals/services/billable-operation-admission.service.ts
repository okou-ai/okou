import { command } from "ccstate";
import { writeDb$ } from "../external/db";

import {
  resolveActiveRunCreditAdmission,
  resolveOrgCreditAvailability,
} from "./run-admission.service";
import { resolveUsageAllowanceAvailability$ } from "./usage-allowance-availability.service";

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
    const availability = await resolveOrgCreditAvailability({
      db: set(writeDb$),
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!availability || availability.status !== "active") {
      return false;
    }
    const activeRunAdmission = await resolveActiveRunCreditAdmission({
      db: set(writeDb$),
      runId: args.runId,
      orgId: args.orgId,
      userId: args.userId,
    });
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
