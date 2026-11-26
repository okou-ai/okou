import { loadProactivePreferences$ } from "./proactive-workflows-eligibility.service";
import { proactiveDispatchPhase$ } from "./proactive-dispatch-ownership.service";
import {
  standalonePreference$,
  setStandalonePreferences$,
} from "./proactive-dispatch-state.service";
import { command } from "ccstate";

import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";
import { loadMorningBriefOwnership$ } from "./morning-brief-state.service";
import { repairMorningBriefSchedule$ } from "./morning-brief-schedule-repair.service";
import type { WorkflowMember } from "./workflow-data.service";

/** Repair an existing installation without publishing a new enable choice. */
export const reconcileExistingMorningBrief$ = command(
  async (
    { get, set },
    args: { readonly orgId: string; readonly member: WorkflowMember },
    signal: AbortSignal,
  ): Promise<"current" | "absent" | "ineligible" | "conflict"> => {
    const owner = { orgId: args.orgId, userId: args.member.userId };
    if ((await set(proactiveDispatchPhase$, signal)) !== "automation") {
      const preference = await set(
        standalonePreference$,
        owner,
        "morning-brief",
        signal,
      );
      if (!preference.enabled) {
        return "absent";
      }
      const { timezone } = await set(loadProactivePreferences$, owner, signal);
      const saved = await set(
        setStandalonePreferences$,
        {
          owner,
          tasks: ["morning-brief"],
          enabled: true,
          timezone,
          preserveChoice: true,
        },
        signal,
      );
      return saved ? "current" : "conflict";
    }
    const ownership = await set(loadMorningBriefOwnership$, owner, signal);
    if (!ownership.installation) {
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
    const reconciled = await set(
      repairMorningBriefSchedule$,
      {
        orgId: args.orgId,
        userId: args.member.userId,
        workflowId: ownership.installation.id,
      },
      signal,
    );
    signal.throwIfAborted();
    return reconciled ? "current" : "conflict";
  },
);
