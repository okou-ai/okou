import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import type {
  ProactivePreference,
  ProactiveWorkflowKind,
} from "@okouai/api-contracts/contracts/proactive";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
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

const PREFERENCE_CONTRACTS = {
  jobs: proactiveJobsContract,
  suggestions: proactiveSuggestionsContract,
  learning: proactiveLearningContract,
} as const;

type ProactivePreferenceKind = Exclude<ProactiveWorkflowKind, "planning">;

const PREFERENCE_FIELDS = {
  jobs: "proactiveJobsEnabled",
  suggestions: "proactiveSuggestionsEnabled",
  learning: "proactiveLearningEnabled",
} as const;

const readProactivePreference$ = command(
  async (
    { get, set },
    owner: ProactiveWorkflowOwner,
    kind: ProactivePreferenceKind,
    signal: AbortSignal,
  ): Promise<ProactivePreference> => {
    const definitions =
      kind === "jobs"
        ? [
            PROACTIVE_WORKFLOW_DEFINITIONS.planning,
            PROACTIVE_WORKFLOW_DEFINITIONS.jobs,
          ]
        : [PROACTIVE_WORKFLOW_DEFINITIONS[kind]];
    const eligibility = await set(
      loadProactiveWorkflowsEligibility$,
      owner,
      signal,
    );
    const automations = await get(db$)
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
          or(
            ...definitions.map((definition) => {
              return and(
                eq(workflows.officialDefinitionName, definition.name),
                eq(
                  workflowAutomations.officialBlueprintKey,
                  definition.blueprintKey,
                ),
              );
            }),
          ),
          eligibility.agentId === null
            ? undefined
            : eq(workflows.agentId, eligibility.agentId),
        ),
      );
    signal.throwIfAborted();
    const unavailableReason =
      eligibility.agentId === null
        ? "missing-default-agent"
        : (kind === "learning" || kind === "jobs") &&
            eligibility.timezone === null
          ? "missing-timezone"
          : null;
    return {
      enabled: eligibility[kind].enabled,
      status: !eligibility[kind].active
        ? "paused"
        : automations.some((automation) => {
              return automation.status === "failed" || automation.failures;
            })
          ? "error"
          : unavailableReason === null &&
              automations.length === definitions.length &&
              automations.every((automation) => {
                return automation.enabled && automation.status === "current";
              })
            ? "enabled"
            : "preparing",
      unavailableReason,
    };
  },
);

function createProactivePreferenceRoutes(
  kind: ProactivePreferenceKind,
): readonly RouteEntry[] {
  const contract = PREFERENCE_CONTRACTS[kind];
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
        return resourceUnavailable("Proactive is not enabled.");
      }
      if (update) {
        const body = await get(bodyResultOf(contract.update));
        signal.throwIfAborted();
        if (!body.ok) {
          return body.response;
        }
        const choice = { [PREFERENCE_FIELDS[kind]]: body.data.enabled };
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
export const proactiveLearningRoutes =
  createProactivePreferenceRoutes("learning");
