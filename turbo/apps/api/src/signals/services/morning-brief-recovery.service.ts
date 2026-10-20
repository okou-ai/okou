import { command } from "ccstate";

import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";
import { loadMorningBriefOwnership$ } from "./morning-brief-state.service";
import { synchronizeMorningBriefTimezone$ } from "./morning-brief-timezone.service";
import { reconcileOfficialMorningBriefSchedule$ } from "./official-workflow-reconciliation.service";
import type { WorkflowMember } from "./workflow-data.service";

/** Repair an existing installation without publishing a new enable choice. */
export const reconcileExistingMorningBrief$ = command(
  async (
    { get, set },
    args: { readonly orgId: string; readonly member: WorkflowMember },
    signal: AbortSignal,
  ): Promise<"current" | "absent" | "ineligible" | "conflict"> => {
    const owner = { orgId: args.orgId, userId: args.member.userId };
    const ownership = await set(loadMorningBriefOwnership$, owner, signal);
    if (ownership.installation?.installationState !== "installed") {
      return "absent";
    }
    if (ownership.enrollment?.state === "departed") {
      return "ineligible";
    }
    const membership = await settle(
      loadCurrentMembershipId(get(clerk$), owner, signal),
      signal,
    );
    if (!membership.ok) {
      if (isClerkResourceNotFound(membership.error)) {
        return "ineligible";
      }
      throw membership.error;
    }
    if (membership.value === null) {
      return "ineligible";
    }
    signal.throwIfAborted();
    const synchronized = await set(
      synchronizeMorningBriefTimezone$,
      args,
      signal,
    );
    if (synchronized === "conflict") {
      return "conflict";
    }
    const reconciled = await set(
      reconcileOfficialMorningBriefSchedule$,
      {
        ...args,
        workflowId: ownership.installation.id,
        activeDefinitionOnly: true,
      },
      signal,
    );
    signal.throwIfAborted();
    return reconciled.kind === "current" ? "current" : "conflict";
  },
);
