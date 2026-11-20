import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import type {
  ProactivePreference,
  ProactiveWorkflowKind,
} from "@okouai/api-contracts/contracts/proactive";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { feedPreferences } from "@okouai/db/schema/feed-preference";
import { publishAgentSuggestionsChangedSafely } from "../external/realtime";
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
  suggestions: proactiveSuggestionsContract,
  learning: proactiveLearningContract,
} as const;

const readProactivePreference$ = command(
  async (
    { get },
    owner: ProactiveWorkflowOwner,
    kind: ProactiveWorkflowKind,
    eligibility: Awaited<
      ReturnType<typeof loadProactiveWorkflowsEligibility$.write>
    >,
    signal: AbortSignal,
  ): Promise<ProactivePreference> => {
    const definitions =
      kind === "suggestions"
        ? Object.values(PROACTIVE_WORKFLOW_DEFINITIONS)
        : [PROACTIVE_WORKFLOW_DEFINITIONS.learning];
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
        : eligibility[kind].enabled && eligibility.timezone === null
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

const savePreference$ = command(
  async (
    { set },
    owner: ProactiveWorkflowOwner,
    {
      enabled,
      withFeed,
    }: {
      readonly enabled: boolean;
      readonly withFeed: boolean;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // Mirror the retired choice for outgoing API instances; Suggestions owns both jobs.
    const choice = {
      proactiveSuggestionsEnabled: enabled,
      proactiveLearningEnabled: enabled,
    };
    const saveWorkflowPreference = db
      .insert(orgMembersMetadata)
      .values({ ...owner, ...choice })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: { ...choice, updatedAt: nowDate() },
      });
    if (withFeed) {
      // Both upserts commit in one statement, including when either row is new.
      const saved = db.$with("saved_hourly_preference").as(
        saveWorkflowPreference.returning({
          userId: orgMembersMetadata.userId,
        }),
      );
      await db
        .with(saved)
        .insert(feedPreferences)
        .values({ ...owner, suggestions: enabled })
        .onConflictDoUpdate({
          target: [feedPreferences.orgId, feedPreferences.userId],
          set: { suggestions: enabled },
        });
      signal.throwIfAborted();
      await publishAgentSuggestionsChangedSafely(owner);
    } else {
      await saveWorkflowPreference;
    }
    signal.throwIfAborted();
  },
);

function createProactivePreferenceRoutes(
  kind: ProactiveWorkflowKind,
): readonly RouteEntry[] {
  const contract = PREFERENCE_CONTRACTS[kind];
  const preferenceRoute$ = command(
    async (
      { get, set },
      operation: "read" | "update" | "withFeed",
      signal: AbortSignal,
    ) => {
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
      if (operation !== "read") {
        const withFeed = operation === "withFeed";
        if (withFeed && !eligibility.singleAgent) {
          return resourceUnavailable(
            "My Okou proactive settings are not enabled.",
          );
        }
        const body = await get(
          bodyResultOf(
            withFeed
              ? proactiveSuggestionsContract.updateWithFeed
              : contract.update,
          ),
        );
        signal.throwIfAborted();
        if (!body.ok) {
          return body.response;
        }
        await set(
          savePreference$,
          owner,
          { enabled: body.data.enabled, withFeed },
          signal,
        );
        const setup = await settle(
          set(ensureProactiveWorkflows$, owner, signal),
          signal,
        );
        const savedEligibility = await set(
          loadProactiveWorkflowsEligibility$,
          owner,
          signal,
        );
        const preference = await set(
          readProactivePreference$,
          owner,
          kind,
          savedEligibility,
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
        body: await set(
          readProactivePreference$,
          owner,
          kind,
          eligibility,
          signal,
        ),
      };
    },
  );

  const read$ = command(async ({ set }, signal: AbortSignal) => {
    return await set(preferenceRoute$, "read", signal);
  });
  const update$ = command(async ({ set }, signal: AbortSignal) => {
    return await set(preferenceRoute$, "update", signal);
  });
  const auth = { accept: ["session"], requireOrganization: true } as const;
  const routes: RouteEntry[] = [
    { route: contract.get, handler: authRoute(auth, read$) },
    {
      route: contract.update,
      handler: authRoute(auth, update$),
    },
  ];
  if (kind === "suggestions") {
    routes.push({
      route: proactiveSuggestionsContract.updateWithFeed,
      handler: authRoute(
        auth,
        command(async ({ set }, signal: AbortSignal) => {
          return await set(preferenceRoute$, "withFeed", signal);
        }),
      ),
    });
  }
  return routes;
}

export const proactiveSuggestionsRoutes =
  createProactivePreferenceRoutes("suggestions");
// Resident clients may still call this route; it reads and writes the same Suggestions choice.
export const proactiveLearningRoutes =
  createProactivePreferenceRoutes("learning");
