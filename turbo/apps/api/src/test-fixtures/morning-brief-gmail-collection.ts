import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { userConnectors } from "@okouai/db/schema/user-connector";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { now } from "../lib/time";

/**
 * Persistence-only setup for Morning Brief Gmail collection tests.
 *
 * Catalog installation is already proven by the Settings surface, so these
 * helpers seed the same canonical rows that surface writes and then step aside.
 * Nothing here weakens a gate: authorization, account resolution, grants,
 * catalog policy and credentials all run through the production modules under
 * test.
 */

interface MorningBriefOwner {
  readonly orgId: string;
  readonly userId: string;
}

interface MorningBriefInstallationFixture {
  readonly workflowId: string;
  readonly automationId: string;
}

export async function installMorningBriefFixture(
  owner: MorningBriefOwner,
  args: {
    readonly agentId: string;
    readonly timezone?: string;
    readonly enabled?: boolean;
  },
): Promise<MorningBriefInstallationFixture> {
  const [workflow] = await db()
    .insert(workflows)
    .values({
      orgId: owner.orgId,
      agentId: args.agentId,
      name: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
      visibility: "private",
      ownerUserId: owner.userId,
      officialDefinitionName: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
      officialInstallationState: "installed",
      createdBy: owner.userId,
      updatedBy: owner.userId,
    })
    .returning({ id: workflows.id });
  if (!workflow) {
    throw new Error("Expected a Morning Brief installation fixture");
  }
  const [automation] = await db()
    .insert(workflowAutomations)
    .values({
      orgId: owner.orgId,
      workflowId: workflow.id,
      ownerUserId: owner.userId,
      kind: "schedule",
      scheduleType: "cron",
      cronExpression: "0 7 * * *",
      timezone: args.timezone ?? "Asia/Shanghai",
      enabled: args.enabled ?? true,
      // `workflow_automations_official_binding_check` requires the whole
      // official binding, not only the fields this reader happens to consult.
      officialBlueprintKey: MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
      officialAppliedFingerprint: "0".repeat(64),
      officialReconciliationStatus: "current",
      officialParameterBindings: [],
      officialIntendedEnabled: args.enabled ?? true,
      officialResultEmailEnabled: true,
    })
    .returning({ id: workflowAutomations.id });
  if (!automation) {
    throw new Error("Expected a Morning Brief automation fixture");
  }
  return { workflowId: workflow.id, automationId: automation.id };
}

export async function setMorningBriefEnabledFixture(
  workflowId: string,
  enabled: boolean,
): Promise<void> {
  await db()
    .update(workflowAutomations)
    .set({ enabled })
    .where(eq(workflowAutomations.workflowId, workflowId));
}

/** The canonical workflow/user thread the account selection hangs from. */
export async function bindMorningBriefThreadFixture(
  owner: MorningBriefOwner,
  args: { readonly workflowId: string; readonly agentId: string },
): Promise<string> {
  const [thread] = await db()
    .insert(chatThreads)
    .values({ userId: owner.userId, agentId: args.agentId })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error("Expected a Morning Brief thread fixture");
  }
  await db().insert(workflowUserAutomationThreads).values({
    orgId: owner.orgId,
    userId: owner.userId,
    workflowId: args.workflowId,
    chatThreadId: thread.id,
  });
  return thread.id;
}

export async function selectThreadGmailAccountFixture(args: {
  readonly chatThreadId: string;
  readonly connectorId: string;
}): Promise<void> {
  await db()
    .insert(chatThreadConnectorSelections)
    .values({
      chatThreadId: args.chatThreadId,
      connectorId: args.connectorId,
      connectorSlug: "gmail",
    })
    .onConflictDoNothing();
}

export async function revokeAgentConnectorGrantFixture(
  owner: MorningBriefOwner,
  args: { readonly agentId: string; readonly connectorSlug: string },
): Promise<void> {
  await db()
    .delete(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, owner.orgId),
        eq(userConnectors.userId, owner.userId),
        eq(userConnectors.agentId, args.agentId),
        eq(userConnectors.connectorSlug, args.connectorSlug),
      ),
    );
}

/**
 * Age an already-granted permission past its expiry.
 *
 * The grant API only accepts forward-looking durations, so an expired allow —
 * which must collapse to the connector's default policy rather than keep
 * allowing — can only be expressed by moving the stored expiry into the past.
 * The row shape is the real one the permission writer produces.
 */
export async function expirePermissionGrantFixture(
  owner: MorningBriefOwner,
  args: {
    readonly agentId: string;
    readonly connectorSlug: string;
    readonly permission: string;
  },
): Promise<void> {
  const expiredAt = new Date(now() - 60_000);
  await db()
    .update(userPermissionGrants)
    .set({ expiresAt: expiredAt })
    .where(
      and(
        eq(userPermissionGrants.orgId, owner.orgId),
        eq(userPermissionGrants.userId, owner.userId),
        eq(userPermissionGrants.agentId, args.agentId),
        eq(userPermissionGrants.connectorSlug, args.connectorSlug),
        eq(userPermissionGrants.permission, args.permission),
      ),
    );
}

/**
 * Mark the pinned account as needing reconnect.
 *
 * This is the shape an explicit selection takes when it is still present but no
 * longer usable. Deleting the account instead is a different user action: the
 * real deletion endpoint removes the thread selection first, so a later
 * invocation legitimately sees no explicit selection at all.
 */
export async function requireConnectorReconnectFixture(
  connectorId: string,
): Promise<void> {
  await db()
    .update(connectors)
    .set({ needsReconnect: true })
    .where(eq(connectors.id, connectorId));
}

/**
 * Clear a stored token expiry, the shape of a credential that does not expire.
 *
 * GitHub OAuth tokens, personal access tokens and every manual method store
 * `NULL` here. A reader that treats that as "expiring now" drives them into an
 * unsupported refresh and fails before issuing a single provider request.
 */
export async function clearConnectorTokenExpiryFixture(
  connectorId: string,
): Promise<void> {
  await db()
    .update(connectors)
    .set({ tokenExpiresAt: null })
    .where(eq(connectors.id, connectorId));
}
