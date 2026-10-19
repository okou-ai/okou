import { officialWorkflowCreditAccess$ } from "./official-workflow-policy.service";
import { command } from "ccstate";

import { resolveOrgCreditAvailability$ } from "./run-admission.service";

export const checkBillableOperationCredits$ = command(
  async (
    { set },
    args: {
      readonly runId?: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean | "closed"> => {
    const availability = await set(resolveOrgCreditAvailability$, {
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!availability || availability.status !== "active") {
      return false;
    }
    const access = await set(officialWorkflowCreditAccess$, args, signal);
    if (access === "closed") {
      return "closed";
    }
    return (
      access === "free" ||
      availability.usagePackCredits > 0 ||
      availability.spendableCredits > 0
    );
  },
);
