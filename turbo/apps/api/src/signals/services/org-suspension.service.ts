import { command } from "ccstate";
import { insufficientCredits } from "../../lib/error";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

export const rejectSuspendedOrg$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof insufficientCredits> | null> => {
    const capabilities = await set(loadOrgPlanCapabilities$, orgId);
    signal.throwIfAborted();

    return capabilities?.status === "suspended" ? insufficientCredits() : null;
  },
);
