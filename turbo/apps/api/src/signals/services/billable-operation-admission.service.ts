import { command } from "ccstate";

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
    const availability = await set(resolveOrgCreditAvailability$, {
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!availability || availability.status !== "active") {
      return false;
    }
    const activeRunAdmission = await set(resolveActiveRunCreditAdmission$, {
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
