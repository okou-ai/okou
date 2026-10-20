import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  proactiveSuggestionsContract,
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { resourceUnavailable } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  loadProactiveSuggestionsEligibility$,
  type ProactiveSuggestionsOwner,
} from "../services/proactive-suggestions-eligibility.service";
import { ensureProactiveSuggestionsWorkflow$ } from "../services/proactive-suggestions-lifecycle.service";
import { settle } from "../utils";

const readPreference$ = command(
  async (
    { get, set },
    owner: ProactiveSuggestionsOwner,
    signal: AbortSignal,
  ): Promise<ProactiveSuggestionsPreference> => {
    const eligibility = await set(
      loadProactiveSuggestionsEligibility$,
      owner,
      signal,
    );
    const [automation] = await get(db$)
      .select({
        enabled: workflowAutomations.enabled,
        failures: workflowAutomations.consecutiveFailures,
        status: workflowAutomations.officialReconciliationStatus,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          eq(
            workflows.officialDefinitionName,
            PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
          ),
          eligibility.agentId === null
            ? undefined
            : eq(workflows.agentId, eligibility.agentId),
          eq(
            workflowAutomations.officialBlueprintKey,
            PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return {
      enabled: eligibility.enabled,
      status: !eligibility.enabled
        ? "paused"
        : automation?.status === "failed" || automation?.failures
          ? "error"
          : automation?.enabled &&
              automation.status === "current" &&
              eligibility.agentId !== null
            ? "enabled"
            : "preparing",
      unavailableReason:
        eligibility.agentId === null ? "missing-default-agent" : null,
    };
  },
);

const preferenceRoute$ = command(
  async ({ get, set }, update: boolean, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const owner = { orgId: auth.orgId, userId: auth.userId };
    const eligibility = await set(
      loadProactiveSuggestionsEligibility$,
      owner,
      signal,
    );
    if (!eligibility.available) {
      return resourceUnavailable("Agent Suggestion is not enabled.");
    }
    if (update) {
      const body = await get(bodyResultOf(proactiveSuggestionsContract.update));
      signal.throwIfAborted();
      if (!body.ok) {
        return body.response;
      }
      await set(writeDb$)
        .insert(orgMembersMetadata)
        .values({ ...owner, proactiveSuggestionsEnabled: body.data.enabled })
        .onConflictDoUpdate({
          target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
          set: {
            proactiveSuggestionsEnabled: body.data.enabled,
            updatedAt: nowDate(),
          },
        });
      signal.throwIfAborted();
      const setup = await settle(
        set(ensureProactiveSuggestionsWorkflow$, owner, signal),
        signal,
      );
      const preference = await set(readPreference$, owner, signal);
      return {
        status: 200 as const,
        body: setup.ok
          ? preference
          : { ...preference, status: "error" as const },
      };
    }
    return {
      status: 200 as const,
      body: await set(readPreference$, owner, signal),
    };
  },
);

const read$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(preferenceRoute$, false, signal);
});
const update$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(preferenceRoute$, true, signal);
});
const auth = { accept: ["session"], requireOrganization: true } as const;
export const proactiveSuggestionsRoutes: readonly RouteEntry[] = [
  { route: proactiveSuggestionsContract.get, handler: authRoute(auth, read$) },
  {
    route: proactiveSuggestionsContract.update,
    handler: authRoute(auth, update$),
  },
];
