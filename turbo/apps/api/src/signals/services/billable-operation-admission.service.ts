import { command } from "ccstate";
import { writeDb$ } from "../external/db";

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
    return (
      availability.usagePackCredits > 0 || availability.spendableCredits > 0
    );
  },
);
