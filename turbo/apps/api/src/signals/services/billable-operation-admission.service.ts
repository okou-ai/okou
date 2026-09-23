import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";
import {
  resolveActiveRunCreditAdmission,
  resolveOrgCreditAvailability,
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
    const writeDb = set(writeDb$);
    const availability = await resolveOrgCreditAvailability({
      db: writeDb,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!availability || availability.status !== "active") {
      return false;
    }
    const activeRunAdmission = await resolveActiveRunCreditAdmission({
      db: writeDb,
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

    const allowance = await resolveUsageAllowanceAvailability(
      writeDb,
      args.orgId,
    );
    signal.throwIfAborted();
    return (allowance?.remainingUnits ?? 0) > 0;
  },
);
