import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
import type {
  ProactivePreference,
  ProactiveWorkflowKind,
} from "@okouai/api-contracts/contracts/proactive";
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
  loadProactiveWorkflowsEligibility$,
  type ProactiveWorkflowOwner,
} from "../services/proactive-workflows-eligibility.service";
import { ensureProactiveWorkflows$ } from "../services/proactive-workflows-lifecycle.service";
import { PROACTIVE_WORKFLOW_DEFINITIONS } from "../services/proactive-workflow-definitions";
import { settle } from "../utils";

const readProactivePreference$ = command(
  async (
    { get, set },
    owner: ProactiveWorkflowOwner,
    kind: ProactiveWorkflowKind,
    signal: AbortSignal,
  ): Promise<ProactivePreference> => {
    const definition = PROACTIVE_WORKFLOW_DEFINITIONS[kind];
    const eligibility = await set(
      loadProactiveWorkflowsEligibility$,
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
          eq(workflows.officialDefinitionName, definition.name),
          eligibility.agentId === null
            ? undefined
            : eq(workflows.agentId, eligibility.agentId),
          eq(workflowAutomations.officialBlueprintKey, definition.blueprintKey),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return {
      enabled: eligibility[kind].enabled,
      status: !eligibility[kind].active
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

function createProactivePreferenceRoutes(
  kind: ProactiveWorkflowKind,
): readonly RouteEntry[] {
  const contract =
    kind === "jobs" ? proactiveJobsContract : proactiveSuggestionsContract;
  const preferenceRoute$ = command(
    async ({ get, set }, update: boolean, signal: AbortSignal) => {
      const auth = get(organizationAuthContext$);
      const owner = { orgId: auth.orgId, userId: auth.userId };
      const eligibility = await set(
        loadProactiveWorkflowsEligibility$,
        owner,
        signal,
      );
      if (!eligibility[kind].available) {
        return resourceUnavailable(
          kind === "jobs"
            ? "Proactive Jobs is not enabled."
            : "Agent Suggestion is not enabled.",
        );
      }
      if (update) {
        const body = await get(bodyResultOf(contract.update));
        signal.throwIfAborted();
        if (!body.ok) {
          return body.response;
        }
        const choice =
          kind === "jobs"
            ? { proactiveJobsEnabled: body.data.enabled }
            : { proactiveSuggestionsEnabled: body.data.enabled };
        await set(writeDb$)
          .insert(orgMembersMetadata)
          .values({ ...owner, ...choice })
          .onConflictDoUpdate({
            target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
            set: {
              ...choice,
              updatedAt: nowDate(),
            },
          });
        signal.throwIfAborted();
        const setup = await settle(
          set(ensureProactiveWorkflows$, owner, signal),
          signal,
        );
        const preference = await set(
          readProactivePreference$,
          owner,
          kind,
          signal,
        );
        return {
          status: 200 as const,
          body: setup.ok
            ? preference
            : { ...preference, status: "error" as const },
        };
      }
      return {
        status: 200 as const,
        body: await set(readProactivePreference$, owner, kind, signal),
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
  return [
    { route: contract.get, handler: authRoute(auth, read$) },
    {
      route: contract.update,
      handler: authRoute(auth, update$),
    },
  ];
}

export const proactiveSuggestionsRoutes =
  createProactivePreferenceRoutes("suggestions");
export const proactiveJobsRoutes = createProactivePreferenceRoutes("jobs");
