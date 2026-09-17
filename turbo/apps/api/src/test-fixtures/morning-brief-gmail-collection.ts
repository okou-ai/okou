import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { userConnectors } from "@okouai/db/schema/user-connector";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

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

/**
 * Point the canonical thread at an account that no longer resolves.
 *
 * The selection row keeps a syntactically valid connector ID whose account is
 * gone, which is the exact shape that must fail closed instead of silently
 * reading the owner's default mailbox.
 */
export async function breakThreadGmailSelectionFixture(args: {
  readonly chatThreadId: string;
  readonly connectorId: string;
}): Promise<void> {
  await db()
    .delete(chatThreadConnectorSelections)
    .where(eq(chatThreadConnectorSelections.chatThreadId, args.chatThreadId));
  await db().insert(chatThreadConnectorSelections).values({
    chatThreadId: args.chatThreadId,
    connectorId: args.connectorId,
    connectorSlug: "gmail",
  });
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
