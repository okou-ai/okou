import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import type { ProactivePreference } from "@okouai/api-contracts/contracts/proactive";
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
import { proactivePreferenceAccess$ } from "../services/proactive-preference-access";

const readProactivePreference$ = command(
  async (
    { get },
    owner: ProactiveWorkflowOwner,
    eligibility: Awaited<
      ReturnType<typeof loadProactiveWorkflowsEligibility$.write>
    >,
    signal: AbortSignal,
  ): Promise<ProactivePreference> => {
    const definitions = Object.values(PROACTIVE_WORKFLOW_DEFINITIONS);
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
        : eligibility.suggestions.enabled && eligibility.timezone === null
          ? "missing-timezone"
          : null;
    return {
      enabled: eligibility.suggestions.enabled,
      status: !eligibility.suggestions.active
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
    const choice = {
      proactiveSuggestionsEnabled: enabled,
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

const preferenceRoute$ = command(
  async (
    { get, set },
    operation: "read" | "update" | "withFeed",
    signal: AbortSignal,
  ) => {
    const denied = await set(proactivePreferenceAccess$, signal);
    if (denied) {
      return denied;
    }
    const auth = get(organizationAuthContext$);
    const owner = { orgId: auth.orgId, userId: auth.userId };
    const eligibility = await set(
      loadProactiveWorkflowsEligibility$,
      owner,
      signal,
    );
    if (!eligibility.suggestions.available) {
      return resourceUnavailable("Proactive is not enabled.");
    }
    if (operation !== "read") {
      const withFeed = operation === "withFeed";
      const body = await get(
        bodyResultOf(
          withFeed
            ? proactiveSuggestionsContract.updateWithFeed
            : proactiveSuggestionsContract.update,
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
      body: await set(readProactivePreference$, owner, eligibility, signal),
    };
  },
);

const read$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(preferenceRoute$, "read", signal);
});
const update$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(preferenceRoute$, "update", signal);
});
const readAuth = {
  accept: ["session", "agent"],
  requireOrganization: true,
  requiredCapability: "suggestion:read",
} as const;
const writeAuth = {
  ...readAuth,
  requiredCapability: "suggestion:write",
} as const;
export const proactiveSuggestionsRoutes: readonly RouteEntry[] = [
  {
    route: proactiveSuggestionsContract.get,
    handler: authRoute(readAuth, read$),
  },
  {
    route: proactiveSuggestionsContract.update,
    handler: authRoute(writeAuth, update$),
  },
  {
    route: proactiveSuggestionsContract.updateWithFeed,
    handler: authRoute(
      writeAuth,
      command(async ({ set }, signal: AbortSignal) => {
        return await set(preferenceRoute$, "withFeed", signal);
      }),
    ),
  },
];
